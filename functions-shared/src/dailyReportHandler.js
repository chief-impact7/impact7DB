import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { resolveRecipientTarget, resolveRecipientTargets } from './recipientPhone.js';
import { buildSmsQueueDoc } from './smsQueueDoc.js';

// 일일 학습 리포트 발송. 학생별 수동 발송(직원 권한).
// 자유 본문은 승인 템플릿이 아니므로 LMS/SMS(kind='direct')로 보낸다.
function reportTargets(student, data) {
  const fields = Array.isArray(data.recipientFields) && data.recipientFields.length
    ? data.recipientFields
    : null;
  if (fields) return resolveRecipientTargets(student, fields);

  const target = resolveRecipientTarget(student, data.recipientField);
  return target ? [target] : [];
}

export async function handleSendDailyReport(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const studentId = String(data.studentId ?? '').trim();
  const content = String(data.content ?? '').trim();
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(String(data.reportDate ?? ''))
    ? String(data.reportDate)
    : null;
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  if (!content) throw new HttpsError('invalid-argument', '리포트 본문이 비어 있습니다.');

  const snap = await db.collection('students').doc(studentId).get();
  if (!snap.exists) throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');
  const targets = reportTargets(snap.data(), data);
  if (!targets.length) throw new HttpsError('failed-precondition', '수신 연락처가 없습니다.');

  const createdBy = request.auth?.token?.email ?? null;
  const queueIds = [];
  let duplicateCount = 0;

  for (const target of targets) {
    const payload = {
      ...buildSmsQueueDoc({
        phone: target.phone,
        recipientRole: target.field,
        studentId,
        content,
        createdBy,
      }),
      student_id: studentId,
      source: 'parent_report',
      ...(reportDate ? { report_date_kst: reportDate } : {}),
      created_at: FieldValue.serverTimestamp(),
    };
    const ref = data.requestId
      ? db.collection('message_queue').doc(targets.length === 1 ? String(data.requestId) : `${String(data.requestId)}_${target.field}`)
      : db.collection('message_queue').doc();
    try {
      await ref.create(payload);
    } catch (e) {
      if (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))) {
        duplicateCount += 1;
        queueIds.push(ref.id);
        continue;
      }
      throw e;
    }
    queueIds.push(ref.id);
  }

  return {
    queued: duplicateCount < targets.length,
    duplicate: duplicateCount === targets.length,
    queueIds,
    queuedCount: targets.length - duplicateCount,
    duplicateCount,
    channel: 'sms',
    scheduledDate: null,
  };
}
