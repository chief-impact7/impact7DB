import { FieldValue } from 'firebase-admin/firestore';
import { todayKST } from './kst.js';

export async function runScheduledWithdrawals(db, today = todayKST()) {
  const snap = await db.collection('students')
    .where('pre_withdrawal_status', '!=', null)
    .get();

  const targets = [];
  snap.forEach(doc => {
    const student = doc.data();
    if (student.withdrawal_date && student.withdrawal_date <= today) {
      targets.push({ ref: doc.ref, id: doc.id, student });
    }
  });

  let batch = db.batch();
  let opCount = 0;
  let processed = 0;

  async function commitIfNeeded(force = false) {
    if (opCount === 0 || (!force && opCount < 450)) return;
    await batch.commit();
    batch = db.batch();
    opCount = 0;
  }

  for (const { ref, id, student } of targets) {
    const beforeStatus = student.status || student.pre_withdrawal_status || '';
    batch.update(ref, {
      status: '퇴원',
      enrollments: [],
      pre_withdrawal_status: FieldValue.delete(),
      updated_at: FieldValue.serverTimestamp(),
      updated_by: 'scheduled-withdrawal',
    });
    opCount++;

    const historyRef = db.collection('history_logs').doc();
    batch.set(historyRef, {
      doc_id: id,
      change_type: 'WITHDRAW',
      before: JSON.stringify({
        status: beforeStatus,
        withdrawal_date: student.withdrawal_date || '',
        enrollments: student.enrollments || [],
      }),
      after: JSON.stringify({
        status: '퇴원',
        withdrawal_date: student.withdrawal_date || '',
        enrollments: [],
      }),
      google_login_id: 'scheduled-withdrawal',
      timestamp: FieldValue.serverTimestamp(),
    });
    opCount++;
    processed++;
    await commitIfNeeded();
  }

  await commitIfNeeded(true);
  return { checked: snap.size, processed, today };
}
