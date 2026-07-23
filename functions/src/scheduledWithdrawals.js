import { FieldValue } from 'firebase-admin/firestore';
import { ENROLLABLE_STATUSES, LEAVE_STATUSES } from '@impact7/shared/enrollment-status';
import { isAccountRequestDue } from './accountFinalize.js';
import { finalize } from './finalize.js';
import { todayKST } from './kst.js';

export async function runScheduledWithdrawals(db, today = todayKST(), {
  finalizeRequest = finalize,
} = {}) {
  const [withdrawalSnap, leaveSnap] = await Promise.all([
    db.collection('students').where('withdrawal_date', '!=', null).get(),
    db.collection('students').where('pause_start_date', '!=', null).get(),
  ]);
  const students = new Map();
  withdrawalSnap.forEach(doc => students.set(doc.id, { ref: doc.ref, id: doc.id, student: doc.data() }));
  leaveSnap.forEach(doc => students.set(doc.id, { ref: doc.ref, id: doc.id, student: doc.data() }));

  let batch = db.batch();
  let opCount = 0;
  let processed = 0;

  async function commitIfNeeded(force = false) {
    if (opCount === 0 || (!force && opCount < 450)) return;
    await batch.commit();
    batch = db.batch();
    opCount = 0;
  }

  for (const { ref, id, student } of students.values()) {
    const beforeStatus = student.status || '';
    let update = null;
    let afterStatus = beforeStatus;
    let changeType = 'UPDATE';

    if (
      student.withdrawal_date
      && student.withdrawal_date <= today
      && ENROLLABLE_STATUSES.has(student.status)
    ) {
      afterStatus = '퇴원';
      changeType = 'WITHDRAW';
      update = {
        status: afterStatus,
        enrollments: [],
        pre_withdrawal_status: FieldValue.delete(),
      };
    } else if (
      student.status === '퇴원'
      && student.pre_withdrawal_status
      && student.withdrawal_date > today
    ) {
      afterStatus = student.pre_withdrawal_status;
      update = {
        status: afterStatus,
        pre_withdrawal_status: afterStatus,
      };
    } else if (
      LEAVE_STATUSES.has(student.scheduled_leave_status)
      && student.pause_start_date
      && student.pause_start_date <= today
      && ENROLLABLE_STATUSES.has(student.status)
    ) {
      afterStatus = student.scheduled_leave_status;
      update = {
        status: afterStatus,
        scheduled_leave_status: FieldValue.delete(),
      };
    } else if (
      LEAVE_STATUSES.has(student.status)
      && student.pause_start_date > today
    ) {
      afterStatus = '재원';
      update = {
        status: afterStatus,
        scheduled_leave_status: beforeStatus,
      };
    }

    if (!update) continue;
    batch.update(ref, {
      ...update,
      updated_at: FieldValue.serverTimestamp(),
      updated_by: 'scheduled-withdrawal',
    });
    opCount++;

    const historyRef = db.collection('history_logs').doc();
    batch.set(historyRef, {
      doc_id: id,
      change_type: changeType,
      before: JSON.stringify({
        status: beforeStatus,
        withdrawal_date: student.withdrawal_date || '',
        enrollments: student.enrollments || [],
      }),
      after: JSON.stringify({
        status: afterStatus,
        withdrawal_date: student.withdrawal_date || '',
        enrollments: update.enrollments || student.enrollments || [],
      }),
      google_login_id: 'scheduled-withdrawal',
      timestamp: FieldValue.serverTimestamp(),
    });
    opCount++;
    processed++;
    await commitIfNeeded();
  }

  await commitIfNeeded(true);

  const approvedSnap = await db.collection('leave_requests')
    .where('status', '==', 'approved')
    .get();
  const accountRequests = approvedSnap.docs
    .map(doc => ({ ref: doc.ref, request: doc.data() }))
    .filter(({ request }) => request.account_target?.account_id);
  const accountTargets = accountRequests
    .filter(({ request }) => isAccountRequestDue(request, today));

  let accountProcessed = 0;
  const accountFailures = [];
  for (const { ref, request } of accountTargets) {
    try {
      await finalizeRequest(ref, request, { db, today });
      accountProcessed++;
    } catch (error) {
      const requestId = ref.id || ref.path?.split('/').at(-1) || request.id || '';
      const message = String(error?.message || error);
      accountFailures.push({ requestId, message });
      console.error(`[scheduledWithdrawals] 요청 ${requestId} 발효 실패:`, error);
    }
  }

  return {
    checked: students.size,
    processed,
    accountChecked: accountRequests.length,
    accountProcessed,
    accountFailures,
    today,
  };
}
