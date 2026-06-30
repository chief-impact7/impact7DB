import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { studentFullLabel } from '@impact7/shared/student-label';
import { todayKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';
import {
  isTabletEligibleStatus, DAY_STATES, ACTIONS, allowedActions,
  nextDayState, canDepart, ACTION_TEMPLATE_KEY, formatKstClock12h,
} from './attendanceState.js';
import { normalizeAttendanceLabel } from '@impact7/shared/attendance-action';
import { PARENT_NOTICE_TEMPLATES, buildParentNoticeVariables } from './parentNoticeHandler.js';
import { applyTemplate } from './templates.js';
import { resolveRecipientPhone } from './recipientPhone.js';

function textOf(v) { return String(v ?? '').trim(); }

// "김민수"→"김*수", "홍길동"→"홍*동", 2글자 "김수"→"김*".
function maskName(name) {
  const chars = [...String(name ?? '').trim()];
  if (chars.length <= 1) return chars.join('');
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

const DEFAULT_POLICY = 'block';

async function readDevicePolicy(firestore, deviceId) {
  const id = textOf(deviceId);
  if (!id) return DEFAULT_POLICY;
  const snap = await firestore.collection('kiosk_devices').doc(id).get();
  if (!snap.exists) return DEFAULT_POLICY;
  const p = snap.data()?.departure_policy;
  return p === 'warn' || p === 'allow' ? p : DEFAULT_POLICY;
}

function dayStateOf(dailyData) {
  return dailyData?.day_state || DAY_STATES.NONE;
}

const REENTRY_WINDOW_MS = 20_000;

function arrivalTimeKST(date) {
  return date.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// 액션별 알림톡 message_queue payload. 템플릿 코드 미설정이어도 fallback_text로 적재.
function buildEventQueuePayload({ studentId, studentName, recipientPhone, action, occurredAt, eventId }) {
  const templateKey = ACTION_TEMPLATE_KEY[action];
  const def = PARENT_NOTICE_TEMPLATES[templateKey];
  const variables = buildParentNoticeVariables({ name: studentName }, templateKey, { 시각: formatKstClock12h(occurredAt) });
  const templateCode = process.env[def.envKey] || `${def.envKey}_PENDING`;
  return {
    // 워커 계약(queueWorker ALLOWED_KINDS): 정보성 알림은 'attendance'. 이벤트 종류는 event_id/attendance_events.type가 식별.
    kind: 'attendance',
    event_id: eventId,
    student_id: studentId,
    recipient_phone: recipientPhone,
    template_code: templateCode,
    template_variables: variables,
    fallback_text: applyTemplate(def.fallback, variables),
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    source: 'tablet',
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  };
}

async function lookupCandidates(firestore, studentNumber, departurePolicy) {
  const dateKST = todayKST();
  const snap = await firestore
    .collection('students')
    .where('studentNumber', '==', studentNumber)
    .get();

  const eligible = snap.docs
    .map(d => ({ studentId: d.id, ...d.data() }))
    .filter(s => isTabletEligibleStatus(s.status));

  const out = [];
  for (const s of eligible) {
    const dailySnap = await firestore.collection('daily_records').doc(`${s.studentId}_${dateKST}`).get();
    const daily = dailySnap.exists ? dailySnap.data() : null;
    const dayState = dayStateOf(daily);
    const checklistComplete = !!daily?.checklist_complete;
    out.push({
      studentId: s.studentId,
      name: maskName(s.name),
      label: studentFullLabel(s),
      dayState,
      allowedActions: allowedActions(dayState, { checklistComplete, departurePolicy }),
      checklistComplete,
      checklistPending: Array.isArray(daily?.checklist_pending) ? daily.checklist_pending : [],
    });
  }
  return out;
}

export async function handleTabletCheckin(request, deps = {}) {
  assertAuthorizedStaff(request.auth, { allowKiosk: true });
  const firestore = deps.firestore || getFirestore();
  const data = request.data ?? {};

  const studentNumber = textOf(data.studentNumber);
  if (!studentNumber) throw new HttpsError('invalid-argument', 'studentNumber가 필요합니다.');

  const studentId = textOf(data.studentId);
  // 구 클라이언트의 '복귀'/'귀가'도 표준('귀원'/'하원')으로 정규화해 수용.
  const action = normalizeAttendanceLabel(textOf(data.action));
  const departurePolicy = await readDevicePolicy(firestore, data.deviceId);

  // 조회: studentId/action 없으면 후보 목록 반환.
  if (!studentId && !action) {
    const candidates = await lookupCandidates(firestore, studentNumber, departurePolicy);
    return { result: 'candidates', candidates };
  }

  // 확정 단계.
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  if (!Object.values(ACTIONS).includes(action)) {
    throw new HttpsError('invalid-argument', `action은 ${Object.values(ACTIONS).join('/')} 중 하나여야 합니다.`);
  }

  const dateKST = todayKST();
  const studentRef = firestore.collection('students').doc(studentId);
  const dailyRef = firestore.collection('daily_records').doc(`${studentId}_${dateKST}`);

  return firestore.runTransaction(async (tx) => {
    const [studentSnap, dailySnap] = await Promise.all([tx.get(studentRef), tx.get(dailyRef)]);
    if (!studentSnap.exists) throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');
    const student = studentSnap.data();
    if (textOf(student.studentNumber) !== studentNumber) {
      throw new HttpsError('failed-precondition', '학생번호가 일치하지 않습니다.');
    }
    if (!isTabletEligibleStatus(student.status)) {
      throw new HttpsError('failed-precondition', '재원·실휴원·가휴원 상태의 학생만 처리할 수 있습니다.');
    }

    const daily = dailySnap.exists ? dailySnap.data() : null;
    const curState = dayStateOf(daily);
    const checklistComplete = !!daily?.checklist_complete;

    // 연타 멱등: 직전 동일 액션이 윈도 내면 no-op.
    const lastEvent = daily?.last_event;
    const nowMs = Date.now();
    if (lastEvent && lastEvent.action === action && (nowMs - (lastEvent.at_ms || 0)) < REENTRY_WINDOW_MS) {
      return { result: 'duplicate', dayState: curState, action, eventId: lastEvent.event_id || null, queued: false };
    }

    // 전이 유효성
    const newState = nextDayState(curState, action);
    if (!newState) {
      throw new HttpsError('failed-precondition', `현재 상태(${curState})에서 ${action}을(를) 할 수 없습니다.`);
    }
    // 하원 게이트
    if (action === ACTIONS.DEPART && !canDepart(checklistComplete, departurePolicy)) {
      throw new HttpsError('failed-precondition', '미완료 항목이 있어 선생님 확인이 필요합니다.');
    }

    const occurredAt = new Date();
    const email = request.auth.token?.email || '';
    const deviceId = textOf(data.deviceId);

    // 이벤트 append
    const eventRef = firestore.collection('attendance_events').doc();
    const recipientPhone = resolveRecipientPhone(student, 'parent_1') || resolveRecipientPhone(student, 'parent_2');
    let queueId = null;
    if (recipientPhone) {
      const queueRef = firestore.collection('message_queue').doc();
      queueId = queueRef.id;
      tx.set(queueRef, buildEventQueuePayload({
        studentId, studentName: textOf(student.name), recipientPhone,
        action, occurredAt, eventId: eventRef.id,
      }));
    }
    tx.set(eventRef, {
      student_id: studentId,
      student_name: textOf(student.name),
      student_number: studentNumber,
      date_kst: dateKST,
      type: action,
      occurred_at: FieldValue.serverTimestamp(),
      source: 'tablet',
      device_id: deviceId,
      created_by: email,
      queue_id: queueId,
    });

    // daily_records 동기화
    const dailyUpdate = {
      student_id: studentId,
      date: dateKST,
      branch: student.branch || '',
      day_state: newState,
      last_event: { action, at_ms: nowMs, event_id: eventRef.id },
      updated_by: email,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (action === ACTIONS.ARRIVE) {
      dailyUpdate.attendance = { status: '출석' };
      if (!daily?.arrival_time) dailyUpdate.arrival_time = arrivalTimeKST(occurredAt);
    }
    if (action === ACTIONS.DEPART) {
      const departure = {
        status: ACTIONS.DEPART,
        time: arrivalTimeKST(occurredAt),
        confirmed_by: email,
        confirmed_at: occurredAt.toISOString(),
        source: 'tablet',
      };
      if (!checklistComplete && Array.isArray(daily?.checklist_pending)) {
        departure.incomplete_items = daily.checklist_pending;
      }
      dailyUpdate.departure = departure;
    }
    tx.set(dailyRef, dailyUpdate, { merge: true });

    return { result: 'created', dayState: newState, action, eventId: eventRef.id, queued: !!queueId };
  });
}
