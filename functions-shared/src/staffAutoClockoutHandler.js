import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { todayKST } from '@impact7/shared/datetime';
import { STAFF_ACTIONS, STAFF_DAY_STATES } from './staffAttendanceState.js';

function prevDateOfKST(dateKST) {
  const [y, m, d] = dateKST.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
}

export async function handleStaffAutoClockout(deps = {}) {
  const firestore = deps.firestore || getFirestore();
  const prevDate = deps.prevDate ?? prevDateOfKST(todayKST());

  // 22:30 KST = 13:30 UTC (KST=UTC+9, DST 없음)
  const clockoutDate = new Date(`${prevDate}T22:30:00+09:00`);
  const clockoutISO = clockoutDate.toISOString();
  const clockoutMs = clockoutDate.getTime();

  const snap = await firestore.collection('staff_attendance')
    .where('date', '==', prevDate)
    .where('state', '==', STAFF_DAY_STATES.IN)
    .get();

  const batch = firestore.batch();
  let count = 0;

  for (const doc of snap.docs) {
    const att = doc.data();
    if (att.state !== STAFF_DAY_STATES.IN) continue;

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
    count++;
  }

  if (count > 0) await batch.commit();
  console.log(`[staffAutoClockout] ${prevDate} 미퇴근 자동 처리: ${count}명`);
  return { date: prevDate, processed: count };
}
