import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { businessDayKST } from '@impact7/shared/datetime';
import { normalizeAttendanceLabel } from '@impact7/shared/attendance-action';
import { assertAuthorizedStaff } from './authGuards.js';
import {
  STAFF_ACTIONS, STAFF_DAY_STATES, nextStaffDayState, staffAllowedActions,
} from './staffAttendanceState.js';
import { applyTemplate, BRAND_PREFIX } from './templates.js';
import { formatKstClock12h } from './attendanceState.js';

function textOf(v) { return String(v ?? '').trim(); }

const REENTRY_WINDOW_MS = 20_000;
const ACTIVE_STATUS = 'active';
const STATUS_CANCELLED = new Set(['join_cancelled', 'leave_cancelled']);
const AUTO_STATUS_BY_DATE_TYPE = {
  joinDate: { status: 'active', priority: 1, from: ['onboarding', 'join_pending', 'active'] },
  plannedJoinDate: { status: 'active', priority: 1, from: ['onboarding', 'join_pending', 'active'] },
  firstWorkDate: { status: 'active', priority: 1, from: ['onboarding', 'join_pending', 'active'] },
  returnDate: { status: 'active', priority: 1, from: ['inactive', 'leave_pending'] },
  leaveDate: { status: 'inactive', priority: 2, from: ['active', 'leave_pending'] },
  plannedResignationDate: { status: 'terminated', priority: 3, from: ['active', 'inactive', 'leave_pending'] },
  resignationDate: { status: 'terminated', priority: 3, from: ['active', 'inactive', 'leave_pending'] },
  lastWorkDate: { status: 'terminated', priority: 3, from: ['active', 'inactive', 'leave_pending'] },
};

function personnelDatesOf(staff) {
  const records = Array.isArray(staff?.personnelDates) ? staff.personnelDates : [];
  const out = records
    .filter((record) => record?.type && record?.date)
    .map((record) => ({ type: textOf(record.type), date: textOf(record.date) }));
  for (const type of Object.keys(AUTO_STATUS_BY_DATE_TYPE)) {
    const date = textOf(staff?.[type]);
    if (date && !out.some((record) => record.type === type)) out.push({ type, date });
  }
  return out;
}

function effectiveStaffStatus(staff, dateKST) {
  const current = textOf(staff?.status) || ACTIVE_STATUS;
  if (STATUS_CANCELLED.has(current)) return current;
  const changes = [];
  for (const record of personnelDatesOf(staff)) {
    if (!record.date || record.date > dateKST) continue;
    const change = AUTO_STATUS_BY_DATE_TYPE[record.type];
    if (change?.from.includes(current)) {
      changes.push({ date: record.date, status: change.status, priority: change.priority });
    }
  }
  if (!changes.length) return current;
  changes.sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority);
  return changes[changes.length - 1].status;
}

const STAFF_NOTICE_TEMPLATES = {
  [STAFF_ACTIONS.CLOCK_IN]: {
    envKey: 'STAFF_CLOCK_IN_TEMPLATE_CODE',
    fallback: `${BRAND_PREFIX} 출근 안내\n#{성함} 선생님, 출근 처리되었습니다. (#{시각})`,
  },
  [STAFF_ACTIONS.CLOCK_OUT]: {
    envKey: 'STAFF_CLOCK_OUT_TEMPLATE_CODE',
    fallback: `${BRAND_PREFIX} 퇴근 안내\n#{성함} 선생님, 퇴근 처리되었습니다. (#{시각})`,
  },
  [STAFF_ACTIONS.OUT]: {
    envKey: 'STAFF_OUT_TEMPLATE_CODE',
    fallback: `${BRAND_PREFIX} 외출 안내\n#{성함} 선생님, 외출 처리되었습니다. (#{시각})`,
  },
  [STAFF_ACTIONS.RETURN]: {
    envKey: 'STAFF_RETURN_TEMPLATE_CODE',
    fallback: `${BRAND_PREFIX} 귀원 안내\n#{성함} 선생님, 귀원 처리되었습니다. (#{시각})`,
  },
};

function buildStaffEventQueuePayload({ staffId, staffName, recipientPhone, action, occurredAt }) {
  const def = STAFF_NOTICE_TEMPLATES[action];
  const clock = formatKstClock12h(occurredAt);
  const variables = { '#{성함}': staffName, '#{시각}': clock };
  const templateCode = process.env[def.envKey] || `${def.envKey}_PENDING`;
  return {
    kind: 'attendance',
    staff_id: staffId,
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

async function lookupStaff(firestore, phoneKey, dateKST) {
  const snap = await firestore.collection('staff').where('phoneKey', '==', phoneKey).get();
  const out = [];
  for (const d of snap.docs) {
    const s = d.data();
    if (effectiveStaffStatus(s, dateKST) !== ACTIVE_STATUS) continue;
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
  assertAuthorizedStaff(request.auth);
  const firestore = deps.firestore || getFirestore();
  const data = request.data ?? {};

  const phoneKey = textOf(data.phoneKey);
  if (!phoneKey) throw new HttpsError('invalid-argument', 'phoneKey가 필요합니다.');

  const staffId = textOf(data.staffId);
  // 구 클라이언트가 보내는 '복귀'도 표준 '귀원'으로 정규화해 수용(학생 핸들러와 동일).
  const action = normalizeAttendanceLabel(textOf(data.action));

  let settings = 'settings' in deps ? deps.settings : null;
  if (!('settings' in deps)) {
    try {
      const sSnap = await firestore.collection('settings').doc('staff_attendance').get();
      if (sSnap.exists) settings = sSnap.data();
    } catch (e) {
      console.warn('[staffCheckin] settings 조회 실패, 기본값 사용:', e?.message);
    }
  }
  const dateKST = businessDayKST(new Date(), settings?.dayStartHour ?? 6);

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
    const effectiveStatus = effectiveStaffStatus(staff, dateKST);
    if (effectiveStatus !== ACTIVE_STATUS) {
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

    if (textOf(staff.status) !== effectiveStatus) tx.set(staffRef, { status: effectiveStatus }, { merge: true });
    tx.set(attRef, update, { merge: true });

    try {
      const notifyPhone = textOf(staff.attendanceNotifyPhone);
      if (notifyPhone) {
        const queueRef = firestore.collection('message_queue').doc();
        tx.set(queueRef, buildStaffEventQueuePayload({
          staffId, staffName: textOf(staff.name), recipientPhone: notifyPhone,
          action, occurredAt,
        }));
      }
    } catch (notifyErr) {
      console.warn('[staffCheckin] 알림 큐 준비 실패(출퇴근 기록은 계속):', notifyErr?.message ?? notifyErr);
    }

    return { result: 'created', dayState: newState, action };
  });
}
