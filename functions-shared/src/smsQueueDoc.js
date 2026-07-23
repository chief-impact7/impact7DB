import { HttpsError } from 'firebase-functions/v2/https';
import { randomUUID } from 'node:crypto';
import { assertSmsTextFits, splitSmsText } from './messageLength.js';

export function buildSmsQueueDoc({
  kind = 'direct',
  studentId = null,
  phone,
  recipientRole = null,
  campaignId = null,
  content,
  scheduledDate = null,
  createdBy = null,
  adFlag = false,
  consent = null,
  resultCallback = null,
  imageId = null,
  splitGroupId = null,
  partIndex = null,
  partTotal = null,
}) {
  assertSmsTextFits(content, { canSplit: !adFlag && imageId == null });
  const doc = {
    kind,
    status: partIndex > 1 ? 'split_waiting' : 'pending',
    recipient_phone: phone,
    content,
    scheduled_date: scheduledDate ?? null,
    attempt_count: 0,
    next_attempt_at: null,
  };
  if (studentId != null) doc.student_id = studentId;
  if (recipientRole != null) doc.recipient_role = recipientRole;
  if (campaignId != null) doc.campaign_id = campaignId;
  if (createdBy != null) doc.created_by = createdBy;
  if (adFlag) doc.ad_flag = true;
  if (consent != null) {
    doc.consent_snapshot = { sms: true, source: consent?.source ?? null, at: consent?.at ?? null };
  }
  if (resultCallback != null) doc.result_callback = resultCallback;
  if (imageId != null) doc.image_id = imageId;
  if (partTotal > 1) {
    doc.split_group_id = splitGroupId;
    doc.split_part_index = partIndex;
    doc.split_part_total = partTotal;
  }
  return doc;
}

export function buildSmsQueueDocs(args, { splitLongMessage = false, splitGroupId = null } = {}) {
  if (!splitLongMessage) return [buildSmsQueueDoc(args)];
  const parts = splitSmsText(args.content);
  if (parts.length === 1) return [buildSmsQueueDoc(args)];
  if (args.adFlag || args.imageId) {
    throw new HttpsError('invalid-argument', '홍보문자와 MMS는 여러 건 자동 분할을 지원하지 않습니다.');
  }
  const groupId = splitGroupId || randomUUID();
  return parts.map((content, index) => buildSmsQueueDoc({
    ...args,
    content,
    splitGroupId: groupId,
    partIndex: index + 1,
    partTotal: parts.length,
  }));
}
