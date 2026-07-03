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
// absence_notice_id로 absence_notices doc을 역참조 — syncAbsenceNoticeDeliveryStatus가 이 값으로
// 큐 상태(sent/failed 등)를 되돌려 쓴다.
function buildAbsenceQueueDoc({ studentId, name, phone, 일시, source, createdBy = null, absenceNoticeId }) {
  const def = PARENT_NOTICE_TEMPLATES.absence;
  const variables = buildParentNoticeVariables({ name }, 'absence', { 일시 });
  return {
    kind: 'parent_notice',
    student_id: studentId,
    absence_notice_id: absenceNoticeId,
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
      absenceNoticeId: noticeRef.id,
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
        absenceNoticeId: noticeRef.id,
      }));
      sent += 1;
    } catch (e) {
      console.error('[absence] enqueue 실패, 멱등 롤백', doc.id, e?.message ?? e);
      await noticeRef.delete().catch(() => {}); // 롤백 실패는 다음 스윕이 재시도.
    }
  }
  return { sent, checked, disabled: false };
}

// message_queue(absence_notice_id 보유 doc)의 상태 변화(pending/processing/재시도/종결 전부)를
// absence_notices에 안전 필드만 반영 — 로그북 '미도착' 배지가 발송 요청뿐 아니라 처리 경과·최종
// 결과(성공/실패)까지 보여주도록. message_queue는 평문 번호를 담아 클라 read가 차단돼 있으므로
// (rules) 이 미러링이 필요하다. queueWorker.js는 발송 종류에 무관해야 해서 absence 특화 로직을
// 여기 전용 트리거로 분리한다(공용 워커에 특수 케이스 얹지 않음).
// message_queue/{id} 전체 쓰기마다 호출되지만(onStudentLabelSync와 동일 패턴), absence_notice_id가
// 없는 문서는 첫 줄에서 즉시 반환 — 다른 발송 종류엔 실질 비용이 거의 없다.
export async function syncAbsenceNoticeDeliveryStatus(event, deps = {}) {
  const db = deps.db ?? getFirestore();
  const afterSnap = event.data?.after;
  const after = afterSnap?.data();
  if (!after) return null; // 삭제는 무시
  if (!after.absence_notice_id) return null; // 미등원 알림톡 큐 doc이 아님
  const before = event.data?.before?.data();
  if (before?.status === after.status) return null; // 상태 변화 없으면 스킵(중복 write 방지)

  // Firestore 트리거는 at-least-once이며 도착 순서를 보장하지 않는다 — 콜드스타트 등으로 이전
  // 이벤트(예: processing) 처리가 이후 이벤트(예: sent)보다 늦게 커밋되면 배지가 과거 상태로 되돌아가
  // 고착될 수 있다. 이 write의 Firestore 커밋 시각(afterSnap.updateTime)을 단조 가드로 써서,
  // absence_notices에 이미 더 최신 이벤트가 반영돼 있으면 트랜잭션 안에서 건너뛴다.
  const sourceUpdatedAt = afterSnap.updateTime ?? null;
  const noticeRef = db.collection('absence_notices').doc(after.absence_notice_id);
  await db.runTransaction(async (tx) => {
    if (sourceUpdatedAt) {
      const prev = (await tx.get(noticeRef)).data()?.delivery_source_updated_at;
      if (prev && prev.toMillis() >= sourceUpdatedAt.toMillis()) return; // 이미 더 최신 상태 반영됨
    }
    tx.set(noticeRef, {
      // 멱등 doc 생성 직후 큐 등록이 모호하게 실패(예: DEADLINE_EXCEEDED인데 실제론 성공)해 호출측이
      // absence_notices를 롤백 삭제했더라도, student_id를 여기서도 채워둬야 재생성된 문서가 배지
      // 조건(firestore-helpers.js의 student_id 존재 체크)을 만족한다.
      student_id: after.student_id ?? null,
      delivery_status: after.status,
      delivery_error_code: after.last_error_code ? String(after.last_error_code).slice(0, 100) : null,
      delivery_source_updated_at: sourceUpdatedAt,
      delivery_updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return null;
}
