import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { businessDayKST } from '@impact7/shared/datetime';
import { STAFF_ACTIONS, STAFF_DAY_STATES } from './staffAttendanceState.js';
import { DEFAULT_STAFF_ATTENDANCE_SETTINGS, resolveAutoTime } from './staffAttendanceSettings.js';

function prevDateOfKST(dateKST) {
  const [y, m, d] = dateKST.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
}

const OPEN_STATES = [STAFF_DAY_STATES.IN, STAFF_DAY_STATES.OUT];

export async function handleStaffAutoClockout(deps = {}) {
  const firestore = deps.firestore || getFirestore();

  let settings = null;
  try {
    const sSnap = await firestore.collection('settings').doc('staff_attendance').get();
    if (sSnap.exists) settings = sSnap.data();
  } catch (e) {
    console.warn('[staffAutoClockout] settings 조회 실패, 기본값 사용:', e?.message);
  }
  const effectiveSettings = settings ?? DEFAULT_STAFF_ATTENDANCE_SETTINGS;

  const dayStartHour = effectiveSettings.dayStartHour ?? 6;
  const prevDate = deps.prevDate ?? prevDateOfKST(businessDayKST(new Date(), dayStartHour));
  const snap = await firestore.collection('staff_attendance')
    .where('date', '==', prevDate)
    .where('state', 'in', OPEN_STATES)
    .get();

  if (snap.empty) {
    console.log(`[staffAutoClockout] ${prevDate} 미퇴근 없음`);
    return { date: prevDate, processed: 0, skipped: 0 };
  }

  const staffIds = [...new Set(snap.docs.map(d => d.data().staffId).filter(Boolean))];
  const deptMap = {};
  await Promise.all(staffIds.map(async (sid) => {
    try {
      const sSnap = await firestore.collection('staff').doc(sid).get();
      deptMap[sid] = sSnap.exists ? (sSnap.data()?.department ?? null) : null;
    } catch {
      deptMap[sid] = null;
    }
  }));

  const batch = firestore.batch();
  let processed = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const att = doc.data();
    if (!OPEN_STATES.includes(att.state)) continue;

    const sid = att.staffId;
    const dept = deptMap[sid] ?? null;
    const time = resolveAutoTime('out', sid, dept, effectiveSettings);
    if (!time) {
      skipped++;
      continue;
    }

    const clockoutDate = new Date(`${prevDate}T${time}:00+09:00`);
    const clockoutISO = clockoutDate.toISOString();
    const clockoutMs = clockoutDate.getTime();

    const events = Array.isArray(att.events) ? [...att.events] : [];
    events.push({ action: STAFF_ACTIONS.CLOCK_OUT, at: clockoutISO, at_ms: clockoutMs });

    batch.update(doc.ref, {
      state: STAFF_DAY_STATES.DONE,
      departAt: clockoutISO,
      events,
      last_event: { action: STAFF_ACTIONS.CLOCK_OUT, at_ms: clockoutMs },
      updated_by: 'system-auto',
      updatedAt: FieldValue.serverTimestamp(),
    });
    processed++;
  }

  if (processed > 0) await batch.commit();
  console.log(`[staffAutoClockout] ${prevDate} 자동 퇴근: ${processed}명 처리, ${skipped}명 설정 없어 스킵`);
  return { date: prevDate, processed, skipped };
}
