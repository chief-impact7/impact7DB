import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { businessDayKST } from '@impact7/shared/datetime';
import { effectiveStaffStatus } from '@impact7/shared/staff-status';
import { STAFF_ACTIONS, STAFF_DAY_STATES } from './staffAttendanceState.js';
import { DEFAULT_STAFF_ATTENDANCE_SETTINGS, resolveAutoTime } from './staffAttendanceSettings.js';

function prevDateOfKST(dateKST) {
  const [y, m, d] = dateKST.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
}

export async function handleStaffAutoClockin(deps = {}) {
  const firestore = deps.firestore || getFirestore();

  let settings = null;
  try {
    const sSnap = await firestore.collection('settings').doc('staff_attendance').get();
    if (sSnap.exists) settings = sSnap.data();
  } catch (e) {
    console.warn('[staffAutoClockin] settings 조회 실패, 기본값 사용:', e?.message);
  }
  const effectiveSettings = settings ?? DEFAULT_STAFF_ATTENDANCE_SETTINGS;

  const dayStartHour = effectiveSettings.dayStartHour ?? 6;
  const prevDate = deps.prevDate ?? prevDateOfKST(businessDayKST(new Date(), dayStartHour));

  // 저장 status 쿼리는 stale(퇴직 미실체화·복직 미반영)을 놓친다 — 전량 읽고 기록 대상일 기준 파생으로 판정
  const staffSnap = await firestore.collection('staff').get();
  const activeDocs = staffSnap.docs.filter(
    (staffDoc) => effectiveStaffStatus(staffDoc.data(), prevDate) === 'active'
  );
  if (!activeDocs.length) {
    console.log(`[staffAutoClockin] active 직원 없음`);
    return { date: prevDate, processed: 0, skipped: 0 };
  }

  let processed = 0;
  let skipped = 0;
  const batch = firestore.batch();

  await Promise.all(activeDocs.map(async (staffDoc) => {
    const staff = staffDoc.data();
    const staffId = staffDoc.id;
    const dept = staff.department ?? null;

    const time = resolveAutoTime('in', staffId, dept, effectiveSettings);
    if (!time) {
      skipped++;
      return;
    }

    const attRef = firestore.collection('staff_attendance').doc(`${prevDate}_${staffId}`);
    const attSnap = await attRef.get();
    if (attSnap.exists) {
      skipped++;
      return;
    }

    const clockinDate = new Date(`${prevDate}T${time}:00+09:00`);
    const clockinISO = clockinDate.toISOString();
    const clockinMs = clockinDate.getTime();

    batch.set(attRef, {
      staffId,
      name: staff.name ?? '',
      date: prevDate,
      yearMonth: prevDate.slice(0, 7),
      state: STAFF_DAY_STATES.IN,
      events: [{ action: STAFF_ACTIONS.CLOCK_IN, at: clockinISO, at_ms: clockinMs }],
      last_event: { action: STAFF_ACTIONS.CLOCK_IN, at_ms: clockinMs },
      arriveAt: clockinISO,
      updated_by: 'system-auto',
      updatedAt: FieldValue.serverTimestamp(),
    });
    processed++;
  }));

  if (processed > 0) await batch.commit();
  console.log(`[staffAutoClockin] ${prevDate} 자동 출근: ${processed}명 처리, ${skipped}명 스킵`);
  return { date: prevDate, processed, skipped };
}
