import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { todayKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';
import { DAY_STATES } from './attendanceState.js';
import { loadExpectedArrival } from './expectedArrivalLoader.js';
import { PARENT_NOTICE_TEMPLATES, buildParentNoticeVariables } from './parentNoticeHandler.js';
import { applyTemplate } from './templates.js';
import { resolveRecipientPhone } from './recipientPhone.js';

// 미등원(결석) 자동 안내 스윕. 등원예정 시각 + 유예가 지났는데 아직 미체크인이고 결석 처리도 없는
// 재원생의 학부모에게 1회 발송한다.
//
// 오탐 방지가 핵심(잘못된 '미등원' 알림은 학부모 불안·신뢰 훼손). 아래 게이트를 모두 통과해야 발송:
//  - 대상은 재원만. 실휴원/가휴원은 요일 스케줄이 남아 있어도 등원 의무가 없어(computeExpectedArrival은
//    status를 보지 않으므로) 상태 기준으로 명시 제외한다.
//  - 이미 체크인(day_state != 미등원) 또는 수동 출결·결석 처리(daily.attendance.status)된 학생 제외.
//  - 사전 결석 통보(absence_records.absence_date == 오늘)된 학생 제외.
//  - 오늘 등원예정이 있고(수업일) 예정 + 유예(GRACE_MIN) 경과분만.
//  - 멱등: absence_notices/{studentId}_{dateKST} create 선점 → 하루 1회.
// 활성화 게이트: ABSENCE_SWEEP_ENABLED='true'일 때만 실제 동작(기본 비활성 — 예정시각 정확도
// 검증 후 켠다).

const GRACE_MIN = 40; // 등원예정 경과 유예(분). 이후에도 미체크인이면 미등원으로 본다.
const SWEEP_LIMIT = 400; // 등원예정 조회(loadExpectedArrival) 호출 상한 — 무거운 조회를 bound해 타임아웃 방지.
const SWEEP_STATUSES = ['재원']; // 휴원은 등원 의무가 없어 제외(오탐 방지).

// "HH:MM" → 분(00:00 기준). 파싱 실패 시 null.
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// KST HH:MM(24h). ICU(toLocaleString timeZone) fallback 위험을 피해 UTC+9로 직접 계산
// (attendanceState.formatKstClock12h와 동일 정책 — 안전 크리티컬 비교에 ICU 미의존).
function nowClockKST(now) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

// 미등원 안내 큐 doc — 자동 스윕/수동 발송 공통. 미승인 시 template_code는 _PENDING(fallback 문자).
function buildAbsenceQueueDoc({ studentId, name, phone, 일시, source, createdBy = null }) {
  const def = PARENT_NOTICE_TEMPLATES.absence;
  const variables = buildParentNoticeVariables({ name }, 'absence', { 일시 });
  return {
    kind: 'parent_notice',
    student_id: studentId,
    recipient_phone: phone,
    template_code: process.env[def.envKey] || `${def.envKey}_PENDING`,
    template_variables: variables,
    fallback_text: applyTemplate(def.fallback, variables),
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    source,
    created_by: createdBy,
    created_at: FieldValue.serverTimestamp(),
  };
}

// 수동 미등원 안내 발송 — 로그북 '미도착(연락)'에서 직원이 확인 후 클릭. 스윕과 같은 멱등 컬렉션
// (absence_notices/{id}_{date})을 써서 자동 스윕을 켜도 중복되지 않는다. 게이트는 멱등만(사람이 판단).
export async function handleSendAbsenceNotice(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);
  const data = request.data ?? {};
  const studentId = String(data.studentId ?? '').trim();
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  const dateKST = deps.dateKST ?? todayKST();

  const snap = await db.collection('students').doc(studentId).get();
  if (!snap.exists) throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');
  const student = snap.data();
  const phone = resolveRecipientPhone(student, 'parent_1');
  if (!phone) throw new HttpsError('failed-precondition', '수신 연락처가 없습니다.');

  // 멱등: 하루 1회 — absence_notices create 선점(스윕과 동일 컬렉션). 이미 있으면 발송 생략.
  const noticeRef = db.collection('absence_notices').doc(`${studentId}_${dateKST}`);
  const createdBy = request.auth?.token?.email ?? null;
  try {
    await noticeRef.create({ student_id: studentId, date: dateKST, source: 'manual', created_by: createdBy, created_at: FieldValue.serverTimestamp() });
  } catch (e) {
    if (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))) {
      return { sent: false, alreadySent: true };
    }
    throw e;
  }

  const expected = String(data.expectedTime ?? '').trim();
  try {
    await db.collection('message_queue').doc().set(buildAbsenceQueueDoc({
      studentId, name: student.name, phone, 일시: expected ? `오늘 ${expected}` : '오늘', source: 'absence_manual', createdBy,
    }));
  } catch (e) {
    await noticeRef.delete().catch(() => {}); // enqueue 실패 시 멱등 롤백(재시도 가능).
    throw new HttpsError('internal', '발송 큐 등록 실패: ' + (e?.message ?? e));
  }
  return { sent: true, alreadySent: false };
}

export async function runAbsenceNoticeSweep(deps = {}) {
  const rawEnabled = deps.enabled ?? process.env.ABSENCE_SWEEP_ENABLED;
  const enabled = rawEnabled === true || rawEnabled === 'true'; // env는 문자열, deps는 boolean 둘 다 허용.
  if (!enabled) return { sent: 0, checked: 0, disabled: true };

  const db = deps.db ?? getFirestore();
  const now = deps.now ?? new Date();
  const dateKST = deps.dateKST ?? todayKST();
  const nowMin = toMinutes(nowClockKST(now));
  const loadExpected = deps.loadExpectedArrival ?? loadExpectedArrival;

  const snap = await db.collection('students').where('status', 'in', SWEEP_STATUSES).get();

  let sent = 0;
  let checked = 0; // loadExpectedArrival 호출 수 — 타임아웃 방어 상한.
  for (const doc of snap.docs) {
    if (checked >= SWEEP_LIMIT) break;
    const student = doc.data();

    // 이미 체크인(등원/외출/하원) 또는 수동 출결·결석 처리된 학생 제외.
    const dailySnap = await db.collection('daily_records').doc(`${doc.id}_${dateKST}`).get();
    const daily = dailySnap.exists ? dailySnap.data() : null;
    if ((daily?.day_state || DAY_STATES.NONE) !== DAY_STATES.NONE) continue;
    if (daily?.attendance?.status) continue;

    // 오늘 등원예정이 없으면(수업 없는 날) 대상 아님.
    checked += 1;
    let expected = '';
    try {
      expected = await loadExpected(db, doc.id, dateKST);
    } catch (e) {
      console.warn('[absence] loadExpectedArrival 실패', doc.id, e?.message ?? e);
      continue;
    }
    const expMin = toMinutes(expected);
    if (expMin == null) continue;
    if (nowMin == null || nowMin < expMin + GRACE_MIN) continue; // 아직 유예 내

    // 사전 결석 통보분 제외 — 오늘 결석이 등록돼 있으면 발송하지 않는다.
    const absSnap = await db.collection('absence_records')
      .where('student_id', '==', doc.id).where('absence_date', '==', dateKST).get();
    if (!absSnap.empty) continue;

    const phone = resolveRecipientPhone(student, 'parent_1'); // parent_1 → parent_2 폴백 내장.
    if (!phone) continue;

    // 멱등: 하루 1회 — create 선점. 이미 있으면 발송 완료로 간주.
    const noticeRef = db.collection('absence_notices').doc(`${doc.id}_${dateKST}`);
    try {
      await noticeRef.create({ student_id: doc.id, date: dateKST, created_at: FieldValue.serverTimestamp() });
    } catch (e) {
      if (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))) continue;
      throw e;
    }

    // enqueue 실패는 이 학생만 건너뛰고(멱등 doc 롤백) 나머지 스윕을 계속한다 — set 실패로 인한
    // 미발송 고착과 루프 중단을 둘 다 막는다.
    try {
      await db.collection('message_queue').doc().set(buildAbsenceQueueDoc({
        studentId: doc.id, name: student.name, phone, 일시: `오늘 ${expected}`, source: 'absence_sweep',
      }));
      sent += 1;
    } catch (e) {
      console.error('[absence] enqueue 실패, 멱등 롤백', doc.id, e?.message ?? e);
      await noticeRef.delete().catch(() => {}); // 롤백 실패는 다음 스윕이 재시도.
    }
  }
  return { sent, checked, disabled: false };
}
