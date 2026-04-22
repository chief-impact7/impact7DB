import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { buildUpdate } from './buildUpdate.js';

const RETURN_TYPES = new Set(['복귀요청', '재등원요청']);

// leave_request 승인 이벤트를 학생 문서·history_logs로 원자적 반영.
export async function finalize(lrRef, r) {
  const db = getFirestore();
  const studentRef = db.doc(`students/${r.student_id}`);

  // 동명이인 체크는 RETURN(재원 전환) 시에만 필요. 다른 유형은 학생 조회 스킵.
  // 활성 집합은 휴원 포함 — 재원 전환 시 휴원 중인 동명이인과도 충돌 방지.
  const stuPromise = RETURN_TYPES.has(r.request_type)
    ? db.collection('students')
        .where('status', 'in', ['재원', '등원예정', '실휴원', '가휴원'])
        .get()
    : Promise.resolve(null);
  // 트랜잭션 밖 스냅샷: 동시 다발 동명 등록 시 race 가능 (현 규모에서는 허용).
  // class_settings는 마스터 데이터라 경합 없음.
  const [csSnap, stuSnap] = await Promise.all([
    db.collection('class_settings').get(),
    stuPromise,
  ]);
  const classSettings = {};
  csSnap.forEach(d => { classSettings[d.id] = d.data(); });
  const allStudents = [];
  if (stuSnap) stuSnap.forEach(d => allStudents.push({ id: d.id, ...d.data() }));

  await db.runTransaction(async tx => {
    const stuDoc = await tx.get(studentRef);
    if (!stuDoc.exists) throw new Error(`student ${r.student_id} not found`);
    const stu = { id: stuDoc.id, ...stuDoc.data() };
    const beforeStatus = stu.status || '';

    const { studentUpdate, enrollments, changeType } = buildUpdate(r, stu, classSettings, allStudents);

    // pause_* / withdrawal_date 정리 (RETURN/WITHDRAW)
    const finalUpdate = { ...studentUpdate };
    if (changeType === 'RETURN') {
      finalUpdate.pause_start_date = FieldValue.delete();
      finalUpdate.pause_end_date = FieldValue.delete();
      finalUpdate.scheduled_leave_status = FieldValue.delete();
      finalUpdate.pre_withdrawal_status = FieldValue.delete();
      if (r.request_type === '재등원요청') {
        finalUpdate.withdrawal_date = FieldValue.delete();
      }
    } else if (changeType === 'WITHDRAW') {
      finalUpdate.pause_start_date = FieldValue.delete();
      finalUpdate.pause_end_date = FieldValue.delete();
      finalUpdate.scheduled_leave_status = FieldValue.delete();
    }
    if (enrollments) finalUpdate.enrollments = enrollments;
    finalUpdate.updated_at = FieldValue.serverTimestamp();
    finalUpdate.updated_by = r.approved_by || r.teacher_approved_by || 'cloud-function';

    tx.update(studentRef, finalUpdate);

    tx.update(lrRef, {
      finalized_at: FieldValue.serverTimestamp(),
      finalize_attempts: FieldValue.increment(1),
      finalize_error: FieldValue.delete(),
      ...(finalUpdate.name ? { student_name: finalUpdate.name } : {}),
    });

    const historyRef = db.collection('history_logs').doc();
    tx.set(historyRef, {
      doc_id: r.student_id,
      change_type: changeType,
      before: JSON.stringify({
        status: beforeStatus,
        pause_start_date: stu.pause_start_date || '',
        pause_end_date: stu.pause_end_date || '',
      }),
      after: JSON.stringify({
        status: studentUpdate.status || beforeStatus,
        pause_start_date: changeType === 'UPDATE' ? (studentUpdate.pause_start_date || '') : '',
        pause_end_date: changeType === 'UPDATE' ? (studentUpdate.pause_end_date || '') : '',
        ...(changeType === 'RETURN' && enrollments ? { enrollments } : {}),
      }),
      google_login_id: r.approved_by || r.teacher_approved_by || 'cloud-function',
      timestamp: FieldValue.serverTimestamp(),
    });
  });
}
