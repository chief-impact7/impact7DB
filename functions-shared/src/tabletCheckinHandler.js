import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { studentFullLabel } from '@impact7/shared/student-label';
import { todayKST } from '@impact7/shared/datetime';
import { assertAuthorizedStaff } from './authGuards.js';
import {
  isTabletEligibleStatus, DAY_STATES, allowedActions,
} from './attendanceState.js';

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
  assertAuthorizedStaff(request.auth);
  const firestore = deps.firestore || getFirestore();
  const data = request.data ?? {};

  const studentNumber = textOf(data.studentNumber);
  if (!studentNumber) throw new HttpsError('invalid-argument', 'studentNumber가 필요합니다.');

  const studentId = textOf(data.studentId);
  const action = textOf(data.action);
  const departurePolicy = await readDevicePolicy(firestore, data.deviceId);

  // 조회: studentId/action 없으면 후보 목록 반환.
  if (!studentId && !action) {
    const candidates = await lookupCandidates(firestore, studentNumber, departurePolicy);
    return { result: 'candidates', candidates };
  }

  // 확정 단계는 Task 4에서 구현.
  throw new HttpsError('unimplemented', '확정 단계 미구현');
}
