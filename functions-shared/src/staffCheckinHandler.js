import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { todayKST } from '@impact7/shared/datetime';
import { normalizeAttendanceLabel } from '@impact7/shared/attendance-action';
import { assertAuthorizedStaff } from './authGuards.js';
import {
  STAFF_ACTIONS, STAFF_DAY_STATES, nextStaffDayState, staffAllowedActions,
} from './staffAttendanceState.js';

function textOf(v) { return String(v ?? '').trim(); }

const REENTRY_WINDOW_MS = 20_000;
const ACTIVE_STATUS = 'active';

async function lookupStaff(firestore, phoneKey, dateKST) {
  const snap = await firestore.collection('staff').where('phoneKey', '==', phoneKey).get();
  const out = [];
  for (const d of snap.docs) {
    const s = d.data();
    if (s.status !== ACTIVE_STATUS) continue;
    const attSnap = await firestore.collection('staff_attendance').doc(`${dateKST}_${d.id}`).get();
    const dayState = (attSnap.exists ? attSnap.data()?.state : null) || STAFF_DAY_STATES.NONE;
    out.push({
      kind: 'staff',
      staffId: d.id,
      name: textOf(s.name),
      englishName: textOf(s.englishName),
      dayState,
      allowedActions: staffAllowedActions(dayState),
    });
  }
  return out;
}

export async function handleStaffCheckin(request, deps = {}) {
  assertAuthorizedStaff(request.auth, { allowKiosk: true });
  const firestore = deps.firestore || getFirestore();
  const data = request.data ?? {};

  const phoneKey = textOf(data.phoneKey);
  if (!phoneKey) throw new HttpsError('invalid-argument', 'phoneKey가 필요합니다.');

  const staffId = textOf(data.staffId);
  // 구 클라이언트가 보내는 '복귀'도 표준 '귀원'으로 정규화해 수용(학생 핸들러와 동일).
  const action = normalizeAttendanceLabel(textOf(data.action));
  const dateKST = todayKST();

  // 조회: staffId/action 없으면 후보 목록 반환.
  if (!staffId && !action) {
    const candidates = await lookupStaff(firestore, phoneKey, dateKST);
    return { result: 'candidates', candidates };
  }

  // 확정 단계.
  if (!staffId) throw new HttpsError('invalid-argument', 'staffId가 필요합니다.');
  if (!Object.values(STAFF_ACTIONS).includes(action)) {
    throw new HttpsError('invalid-argument', `action은 ${Object.values(STAFF_ACTIONS).join('/')} 중 하나여야 합니다.`);
  }

  const staffRef = deps.staffRef || firestore.collection('staff').doc(staffId);
  const attRef = deps.attRef || firestore.collection('staff_attendance').doc(`${dateKST}_${staffId}`);

  return firestore.runTransaction(async (tx) => {
    const [staffSnap, attSnap] = await Promise.all([tx.get(staffRef), tx.get(attRef)]);
    if (!staffSnap.exists) throw new HttpsError('not-found', '직원을 찾을 수 없습니다.');
    const staff = staffSnap.data();
    if (staff.status !== ACTIVE_STATUS) {
      throw new HttpsError('failed-precondition', '재직 중인 직원만 처리할 수 있습니다.');
    }
    // 학생 핸들러(studentNumber 재검증)와 동일한 권한 재확인: 조회 단계에서 받은
    // staffId가 입력 phoneKey의 소유인지 트랜잭션 내에서 다시 확인한다.
    if (textOf(staff.phoneKey) !== phoneKey) {
      throw new HttpsError('failed-precondition', '등록번호가 일치하지 않습니다.');
    }

    const att = attSnap.exists ? attSnap.data() : null;
    const curState = att?.state || STAFF_DAY_STATES.NONE;

    // 연타 멱등: 직전 동일 액션이 윈도 내면 no-op.
    const lastEvent = att?.last_event;
    const nowMs = Date.now();
    if (lastEvent && lastEvent.action === action && (nowMs - (lastEvent.at_ms || 0)) < REENTRY_WINDOW_MS) {
      return { result: 'duplicate', dayState: curState, action };
    }

    const newState = nextStaffDayState(curState, action);
    if (!newState) {
      throw new HttpsError('failed-precondition', `현재 상태(${curState})에서 ${action}을(를) 할 수 없습니다.`);
    }

    const occurredAt = new Date();
    const email = request.auth.token?.email || '';
    const events = Array.isArray(att?.events) ? att.events.slice() : [];
    events.push({ action, at: occurredAt.toISOString(), at_ms: nowMs });

    const update = {
      staffId,
      name: textOf(staff.name),
      date: dateKST,
      yearMonth: dateKST.slice(0, 7),
      state: newState,
      events,
      last_event: { action, at_ms: nowMs },
      updated_by: email,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (action === STAFF_ACTIONS.CLOCK_IN && !att?.arriveAt) update.arriveAt = occurredAt.toISOString();
    if (action === STAFF_ACTIONS.CLOCK_OUT) update.departAt = occurredAt.toISOString();

    tx.set(attRef, update, { merge: true });
    return { result: 'created', dayState: newState, action };
  });
}
