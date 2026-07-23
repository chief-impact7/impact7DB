import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { resolveRecipientTarget, resolveRecipientTargets } from './recipientPhone.js';
import { buildSmsQueueDocs } from './smsQueueDoc.js';
import { hashRequestFingerprint } from './requestFingerprint.js';

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
  const deliveries = targets.map((target) => ({
    target,
    docs: buildSmsQueueDocs({
      phone: target.phone,
      recipientRole: target.field,
      studentId,
      content,
      createdBy,
    }, {
      splitLongMessage: data.splitLongMessage === true,
      splitGroupId: data.requestId ? `daily:${data.requestId}:${studentId}:${target.field}` : null,
    }),
  }));
  const requestFingerprint = hashRequestFingerprint([
    studentId,
    content,
    reportDate,
    targets.map((target) => target.field),
    data.splitLongMessage === true,
  ]);
  const entries = deliveries.flatMap(({ target, docs }) => (
    docs.map((doc, index) => {
      const requestDocId = data.requestId
        ? (docs.length > 1
          ? `daily_${String(data.requestId)}_${target.field}_${index + 1}`
          : `daily_${String(data.requestId)}${targets.length === 1 ? '' : `_${target.field}`}`)
        : null;
      const ref = requestDocId
        ? db.collection('message_queue').doc(requestDocId)
        : db.collection('message_queue').doc();
      return {
        ref,
        payload: {
          ...doc,
          source: 'parent_report',
          request_fingerprint: requestFingerprint,
          ...(reportDate ? { report_date_kst: reportDate } : {}),
          created_at: FieldValue.serverTimestamp(),
        },
      };
    })
  ));
  const sentinelRef = data.requestId
    ? db.collection('message_request_batches').doc(`daily_${String(data.requestId)}`)
    : null;
  const existing = sentinelRef ? await sentinelRef.get() : null;
  if (existing?.exists && existing.data()?.request_fingerprint !== requestFingerprint) {
    throw new HttpsError('invalid-argument', '같은 요청 ID의 발송 내용 또는 수신 대상이 이전 요청과 다릅니다.');
  }
  const legacyRefs = !existing?.exists && data.requestId
    ? targets.map((target) => db.collection('message_queue').doc(
      targets.length === 1 ? String(data.requestId) : `${String(data.requestId)}_${target.field}`,
    ))
    : [];
  const legacyStates = await Promise.all(legacyRefs.map(async (ref, index) => ({
    ref,
    field: targets[index].field,
    exists: (await ref.get()).exists,
  })));
  const existingLegacy = legacyStates.filter((state) => state.exists);
  if (legacyStates.length && existingLegacy.length === legacyStates.length) {
    const legacyQueueIds = existingLegacy.map(({ ref }) => ref.id);
    return {
      queued: false,
      duplicate: true,
      queueIds: legacyQueueIds,
      queuedCount: 0,
      duplicateCount: legacyQueueIds.length,
      channel: 'sms',
      scheduledDate: null,
      splitParts: 1,
    };
  }
  const existingLegacyFields = new Set(existingLegacy.map(({ field }) => field));
  const entriesToCreate = existingLegacy.length
    ? entries.filter(({ payload }) => !existingLegacyFields.has(payload.recipient_role))
    : entries;

  let duplicate = !!existing?.exists;
  if (!duplicate) {
    const batch = db.batch();
    if (sentinelRef) {
      batch.create(sentinelRef, {
        request_fingerprint: requestFingerprint,
        queue_count: existingLegacy.length + entriesToCreate.length,
        created_at: FieldValue.serverTimestamp(),
      });
    }
    for (const { ref, payload } of entriesToCreate) {
      if (sentinelRef) batch.create(ref, payload);
      else batch.set(ref, payload);
    }
    try {
      await batch.commit();
    } catch (e) {
      if (!(sentinelRef && (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))))) throw e;
      const raced = await sentinelRef.get();
      if (raced.data()?.request_fingerprint !== requestFingerprint) {
        throw new HttpsError('invalid-argument', '같은 요청 ID의 발송 내용 또는 수신 대상이 이전 요청과 다릅니다.');
      }
      duplicate = true;
    }
  }

  const queueIds = [
    ...existingLegacy.map(({ ref }) => ref.id),
    ...entriesToCreate.map(({ ref }) => ref.id),
  ];
  return {
    queued: !duplicate,
    duplicate,
    queueIds,
    queuedCount: duplicate ? 0 : entriesToCreate.length,
    duplicateCount: duplicate ? queueIds.length : existingLegacy.length,
    channel: 'sms',
    scheduledDate: null,
    splitParts: deliveries[0]?.docs.length ?? 1,
  };
}
