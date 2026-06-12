import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { isEnrollableStatus } from '@impact7/shared/enrollment-status';
import { studentFullLabel } from '@impact7/shared/student-label';
import { todayKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';
import { buildAttendanceMessage } from './templates.js';

// 솔라피 알림톡 출결 템플릿. 승인 후 T2가 실제 코드를 주입한다(현재 placeholder).
const ATTENDANCE_TEMPLATE_CODE = process.env.ATTENDANCE_TEMPLATE_CODE || 'ATTENDANCE_PENDING';
const VALID_STATUSES = new Set(['출석', '지각', '조퇴', '결석']);
// 도착시간을 기록하는 상태(등원 시점 의미가 있는 것만).
const ARRIVAL_STATUSES = new Set(['출석', '지각']);

function textOf(v) {
  return String(v ?? '').trim();
}

function rawDigits(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

// 후보 목록 이름 부분 마스킹 — 본인은 식별 가능(성+끝자), 타 학생 평문 노출은 차단.
// "김민수"→"김*수", "홍길동"→"홍*동", "김수"→"김*".
function maskName(name) {
  const chars = [...String(name ?? '').trim()];
  if (chars.length <= 1) return chars.join('');
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

// 학부모 수신 번호 우선순위: parent_phone_1 → parent_phone_2. 둘 다 없으면 발송 스킵.
function pickRecipientPhone(student) {
  for (const field of ['parent_phone_1', 'parent_phone_2']) {
    const digits = rawDigits(student?.[field]);
    if (digits) return digits;
  }
  return '';
}

// KST 기준 24시간제 "HH:MM" — daily_records.arrival_time 저장용.
function arrivalTimeKST(date) {
  return date.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// studentNumber로 후보 학생을 조회한다(비고유 → 이름 확인용 목록). 재원 계열만 노출.
async function lookupCandidates(firestore, studentNumber) {
  const snap = await firestore
    .collection('students')
    .where('studentNumber', '==', studentNumber)
    .get();
  return snap.docs
    .map(d => ({ studentId: d.id, ...d.data() }))
    .filter(s => isEnrollableStatus(s.status))
    .map(s => ({
      studentId: s.studentId,
      name: maskName(s.name),
      label: studentFullLabel(s),
    }));
}

function buildQueuePayload({ checkinId, studentId, recipientPhone, studentName, status, occurredAt }) {
  // 템플릿(변수맵·대체발송 본문·브랜드 prefix)은 src/templates.js 한 곳에서 생성한다.
  const message = buildAttendanceMessage({
    studentName,
    status,
    occurredAt,
    templateCode: ATTENDANCE_TEMPLATE_CODE,
  });
  return {
    kind: 'attendance',
    checkin_id: checkinId,
    student_id: studentId,
    recipient_phone: recipientPhone,
    template_code: message.templateCode,
    template_variables: message.templateVariables,
    fallback_text: message.fallbackText,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  };
}

// 단일 트랜잭션: 멱등 클레임 + daily_records merge + message_queue enqueue.
async function runCheckinTransaction(firestore, { studentId, studentNumber, status, deviceLabel, auth }) {
  const dateKST = todayKST();
  const checkinRef = firestore.collection('attendance_checkins').doc(`${studentId}_${dateKST}_${status}`);
  const studentRef = firestore.collection('students').doc(studentId);
  const dailyRef = firestore.collection('daily_records').doc(`${studentId}_${dateKST}`);
  const email = auth.token?.email || '';

  return firestore.runTransaction(async (tx) => {
    const [checkinSnap, studentSnap, dailySnap] = await Promise.all([
      tx.get(checkinRef), tx.get(studentRef), tx.get(dailyRef),
    ]);

    if (!studentSnap.exists) {
      throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');
    }
    const student = studentSnap.data();
    // studentNumber는 인증 수단이 아니라 식별 입력값 — 위변조 방지로 서버에서 재대조.
    // 후보 이름은 마스킹되어 클라가 평문 이름을 못 가지므로, studentId↔studentNumber 결합이
    // 보안 게이트다(이름 echo 검증은 제거). 저장 이름은 서버가 읽은 student.name을 쓴다.
    if (textOf(student.studentNumber) !== studentNumber) {
      throw new HttpsError('failed-precondition', '학생번호가 일치하지 않습니다.');
    }
    if (!isEnrollableStatus(student.status)) {
      throw new HttpsError('failed-precondition', '재원 상태의 학생만 체크인할 수 있습니다.');
    }

    // 같은 학생·같은 KST 날짜·같은 상태 재클릭은 멱등 — 기존 결과를 반환하고 no-op.
    if (checkinSnap.exists) {
      const existing = checkinSnap.data();
      return { result: 'duplicate', checkinId: checkinRef.id, queued: !!existing.queue_id, attendanceSaved: true };
    }

    const occurredAt = new Date();
    const recipientPhone = pickRecipientPhone(student);
    let queueId = null;
    if (recipientPhone) {
      const queueRef = firestore.collection('message_queue').doc();
      queueId = queueRef.id;
      tx.set(queueRef, buildQueuePayload({
        checkinId: checkinRef.id,
        studentId,
        recipientPhone,
        studentName: textOf(student.name),
        status,
        occurredAt,
      }));
    }

    tx.set(checkinRef, {
      student_id: studentId,
      student_name: textOf(student.name),
      student_number: studentNumber,
      status,
      date_kst: dateKST,
      occurred_at: FieldValue.serverTimestamp(),
      source: 'tablet',
      device_label: deviceLabel || '',
      created_by: email,
      queue_id: queueId,
      created_at: FieldValue.serverTimestamp(),
    });

    // attendance는 map — set(merge:true)가 중첩 맵을 deep-merge하므로 다른 하위필드는 보존된다.
    const dailyUpdate = {
      student_id: studentId,
      date: dateKST,
      branch: student.branch || '',
      attendance: { status },
      updated_by: email,
      updated_at: FieldValue.serverTimestamp(),
    };
    // arrival_time 의미는 DSC attendance.js와 일치시킨다.
    // 출석/지각: 기존 arrival_time이 있으면 보존(첫 등원 시각 유지), 없을 때만 기록.
    // 결석/조퇴: 등원 의미가 없으므로 ''로 클리어.
    const existingArrival = dailySnap.exists ? dailySnap.data()?.arrival_time : undefined;
    if (ARRIVAL_STATUSES.has(status)) {
      if (!existingArrival) {
        dailyUpdate.arrival_time = arrivalTimeKST(occurredAt);
      }
    } else {
      dailyUpdate.arrival_time = '';
    }
    tx.set(dailyRef, dailyUpdate, { merge: true });

    return { result: 'created', checkinId: checkinRef.id, queued: !!queueId, attendanceSaved: true };
  });
}

// attendanceCheckin callable 핸들러.
// 두 단계를 지원한다:
//  - 조회: { studentNumber } → 재원 후보 목록 반환(이름 마스킹).
//  - 확정: { studentNumber, studentId, status, deviceLabel? } → 트랜잭션 처리.
export async function handleAttendanceCheckin(request, deps = {}) {
  // 보안 경계는 callable 서버측 — 임의 Google 계정의 studentNumber 열거를 차단한다.
  assertAuthorizedStaff(request.auth);
  const firestore = deps.firestore || getFirestore();
  const data = request.data ?? {};

  const studentNumber = textOf(data.studentNumber);
  if (!studentNumber) {
    throw new HttpsError('invalid-argument', 'studentNumber가 필요합니다.');
  }

  // 확정 요청 판별: studentId + status가 있으면 확정, 없으면 조회.
  const studentId = textOf(data.studentId);
  const status = textOf(data.status);
  if (!studentId && !status) {
    const candidates = await lookupCandidates(firestore, studentNumber);
    return { result: 'candidates', candidates };
  }

  if (!studentId) {
    throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  }
  if (!VALID_STATUSES.has(status)) {
    throw new HttpsError('invalid-argument', 'status는 출석/지각/조퇴/결석 중 하나여야 합니다.');
  }

  return runCheckinTransaction(firestore, {
    studentId,
    studentNumber,
    status,
    deviceLabel: textOf(data.deviceLabel),
    auth: request.auth,
  });
}
