import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { resolveRecipientTarget, resolveRecipientTargets } from './recipientPhone.js';
import { isChannelFriend } from './channelFriendsHandler.js';
import { loadChannelInviteText } from './channelInvite.js';
import { resolveAdScheduledAt } from './promoSchedule.js';

// 일일 학습 리포트 발송. 학생별 수동 발송(직원 권한).
// 친구(채널 가입) → 정보형 BMS(kind='report'), 비친구 → 가입 안내 SMS(kind='direct').
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
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  if (!content) throw new HttpsError('invalid-argument', '리포트 본문이 비어 있습니다.');

  const snap = await db.collection('students').doc(studentId).get();
  if (!snap.exists) throw new HttpsError('not-found', '학생을 찾을 수 없습니다.');
  const targets = reportTargets(snap.data(), data);
  if (!targets.length) throw new HttpsError('failed-precondition', '수신 연락처가 없습니다.');

  const createdBy = request.auth?.token?.email ?? null;
  const scheduledDate = data.reserveIfNight ? resolveAdScheduledAt(deps.now ?? new Date()) : null;

  const suffix = await loadChannelInviteText(db, deps);
  const queueIds = [];
  const channels = new Set();
  let joinedCount = 0;
  let duplicateCount = 0;

  for (const target of targets) {
    const joined = await isChannelFriend(db, target.phone);
    if (joined) joinedCount += 1;
    const base = {
      status: 'pending',
      recipient_phone: target.phone,
      recipient_role: target.field,
      student_id: studentId,
      attempt_count: 0,
      created_by: createdBy,
      created_at: FieldValue.serverTimestamp(),
    };
    let payload;
    let channel;
    if (joined) {
      payload = { ...base, kind: 'report', content, targeting: 'I', ad_flag: false };
      if (scheduledDate) payload.scheduled_date = scheduledDate;
      channel = 'report';
    } else {
      payload = { ...base, kind: 'direct', content: suffix ? `${content}\n\n${suffix}` : content };
      channel = 'invite_sms';
    }
    channels.add(channel);

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
    channel: channels.size === 1 ? [...channels][0] : 'mixed',
    joined: joinedCount === targets.length,
    joinedCount,
    scheduledDate: joinedCount > 0 ? (scheduledDate ?? null) : null,
  };
}
