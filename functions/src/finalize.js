import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { buildAccountFinalize } from './accountFinalize.js';
import { buildUpdate } from './buildUpdate.js';
import { todayKST } from './kst.js';

const RETURN_TYPES = new Set(['복귀요청', '재등원요청']);
const LEAVE_TYPES = new Set(['휴원요청', '퇴원→휴원']);

async function recordFinalizeError(lrRef, error) {
  try {
    await lrRef.update({
      finalize_error: String(error?.message || error),
      finalize_attempts: FieldValue.increment(1),
    });
  } catch (writeError) {
    console.error('[finalize] failed to write finalize_error:', writeError);
  }
}

function historyActor(request) {
  return request.requested_by
    || request.teacher_approved_by
    || request.approved_by
    || 'cloud-function';
}

function updatedByOf(request) {
  return request.approved_by || request.teacher_approved_by || 'cloud-function';
}

export async function finalize(lrRef, _triggerRequest, {
  db = getFirestore(),
  today = todayKST(),
} = {}) {
  try {
    const preview = (await lrRef.get()).data();
    const activeStudentsPromise = RETURN_TYPES.has(preview?.request_type)
      ? db.collection('students')
          .where('status', 'in', ['재원', '등원예정', '실휴원', '가휴원'])
          .get()
      : Promise.resolve(null);
    const [classSettingsSnap, preloadedActiveStudentsSnap] = await Promise.all([
      db.collection('class_settings').get(),
      activeStudentsPromise,
    ]);
    const classSettings = {};
    classSettingsSnap.forEach(doc => { classSettings[doc.id] = doc.data(); });

    return await db.runTransaction(async tx => {
      const lrDoc = await tx.get(lrRef);
      const request = { ...lrDoc.data(), id: lrDoc.id };
      if (request.finalized_at) return { skipped: 'finalized' };

      const studentRef = db.doc(`students/${request.student_id}`);
      const stuDoc = await tx.get(studentRef);
      if (!stuDoc.exists) throw new Error(`student ${request.student_id} not found`);
      const student = { id: stuDoc.id, ...stuDoc.data() };

      if (request.account_target?.account_id) {
        const result = buildAccountFinalize(request, student, today);
        if (result.studentUpdate) {
          const finalUpdate = {
            ...result.studentUpdate,
            updated_at: FieldValue.serverTimestamp(),
            updated_by: updatedByOf(request),
          };
          for (const field of result.markers.delete_student_fields || []) {
            finalUpdate[field] = FieldValue.delete();
          }
          tx.update(studentRef, finalUpdate);
        }

        if (!result.markers.finalized_at) {
          return { applied: false, scheduled: Boolean(result.studentUpdate) };
        }

        const requestUpdate = {
          finalized_at: FieldValue.serverTimestamp(),
          finalize_attempts: FieldValue.increment(1),
          finalize_error: FieldValue.delete(),
        };
        for (const marker of ['start_applied_at', 'end_applied_at']) {
          if (result.markers[marker]) {
            requestUpdate[`account_target.${marker}`] = FieldValue.serverTimestamp();
          }
        }
        tx.update(lrRef, requestUpdate);

        for (const entry of result.historyEntries) {
          tx.set(db.collection('history_logs').doc(), {
            doc_id: request.student_id,
            ...entry,
            google_login_id: historyActor(request),
            timestamp: FieldValue.serverTimestamp(),
          });
        }
        return { applied: true, changeTypes: result.historyEntries.map(entry => entry.change_type) };
      }

      const activeStudentsSnap = RETURN_TYPES.has(request.request_type)
        ? preloadedActiveStudentsSnap || await tx.get(
            db.collection('students')
              .where('status', 'in', ['재원', '등원예정', '실휴원', '가휴원']),
          )
        : null;
      const allStudents = [];
      activeStudentsSnap?.forEach(doc => allStudents.push({ id: doc.id, ...doc.data() }));

      const { studentUpdate, enrollments, changeType } = buildUpdate(
        request,
        student,
        classSettings,
        allStudents,
      );
      const beforeStatus = student.status || '';
      const finalUpdate = { ...studentUpdate };
      if (changeType === 'RETURN') {
        finalUpdate.pause_start_date = FieldValue.delete();
        finalUpdate.pause_end_date = FieldValue.delete();
        finalUpdate.scheduled_leave_status = FieldValue.delete();
        finalUpdate.pre_withdrawal_status = FieldValue.delete();
        if (request.request_type === '재등원요청') {
          finalUpdate.withdrawal_date = FieldValue.delete();
        }
      } else if (changeType === 'WITHDRAW') {
        finalUpdate.pause_start_date = FieldValue.delete();
        finalUpdate.pause_end_date = FieldValue.delete();
        finalUpdate.scheduled_leave_status = FieldValue.delete();
      } else if (changeType === 'UPDATE' && LEAVE_TYPES.has(request.request_type)) {
        finalUpdate.withdrawal_date = FieldValue.delete();
        finalUpdate.pre_withdrawal_status = FieldValue.delete();
        if (studentUpdate.status) {
          finalUpdate.scheduled_leave_status = FieldValue.delete();
        }
      }
      if (enrollments) finalUpdate.enrollments = enrollments;
      finalUpdate.updated_at = FieldValue.serverTimestamp();
      finalUpdate.updated_by = updatedByOf(request);

      tx.update(studentRef, finalUpdate);

      tx.update(lrRef, {
        finalized_at: FieldValue.serverTimestamp(),
        finalize_attempts: FieldValue.increment(1),
        finalize_error: FieldValue.delete(),
        ...(finalUpdate.name ? { student_name: finalUpdate.name } : {}),
      });

      tx.set(db.collection('history_logs').doc(), {
        doc_id: request.student_id,
        change_type: changeType,
        before: JSON.stringify({
          status: beforeStatus,
          pause_start_date: student.pause_start_date || '',
          pause_end_date: student.pause_end_date || '',
        }),
        after: JSON.stringify({
          status: studentUpdate.status || beforeStatus,
          pause_start_date: changeType === 'UPDATE' ? (studentUpdate.pause_start_date || '') : '',
          pause_end_date: changeType === 'UPDATE' ? (studentUpdate.pause_end_date || '') : '',
          ...(changeType === 'RETURN' && enrollments ? { enrollments } : {}),
        }),
        google_login_id: historyActor(request),
        timestamp: FieldValue.serverTimestamp(),
      });
      return { applied: true, changeTypes: [changeType] };
    });
  } catch (error) {
    await recordFinalizeError(lrRef, error);
    throw error;
  }
}
