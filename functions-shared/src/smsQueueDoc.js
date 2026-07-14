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
}) {
  const doc = {
    kind,
    status: 'pending',
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
  return doc;
}
