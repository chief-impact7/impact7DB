import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { resolveRecipientPhone } from './recipientPhone.js';
import { isChannelFriend } from './channelFriendsHandler.js';
import { resolveChannelAddUrl, channelInviteSuffix } from './channelInvite.js';
import { resolveAdScheduledAt } from './promoSchedule.js';

// 일일 학습 리포트 발송. 학생별 수동 발송(직원 권한).
// 친구(채널 가입) → 정보형 BMS(kind='report'), 비친구 → 가입 안내 SMS(kind='direct').
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
  const phone = resolveRecipientPhone(snap.data(), data.recipientField);
  if (!phone) throw new HttpsError('failed-precondition', '수신 연락처가 없습니다.');

  const joined = await isChannelFriend(db, phone);
  const createdBy = request.auth?.token?.email ?? null;
  const channelUrl = resolveChannelAddUrl(deps);

  const base = {
    status: 'pending',
    recipient_phone: phone,
    student_id: studentId,
    attempt_count: 0,
    created_by: createdBy,
    created_at: FieldValue.serverTimestamp(),
  };
  let payload;
  let channel;
  if (joined) {
    // 정보형 BMS: 광고 아님(ad_flag=false), 친구만 수신하므로 SMS 대체는 워커에서 끔.
    payload = { ...base, kind: 'report', content, targeting: 'I', ad_flag: false };
    // 야간(카톡 발송 제한 20:50~08:00)에 예약 요청이 오면 다음 08:00 KST로 예약 발송.
    // 주간이면 resolveAdScheduledAt이 null을 반환해 즉시 발송(예약 없음).
    const scheduledDate = data.reserveIfNight ? resolveAdScheduledAt(deps.now ?? new Date()) : null;
    if (scheduledDate) payload.scheduled_date = scheduledDate;
    channel = 'report';
  } else {
    // 비친구(채널 미가입)에겐 원본 내용을 문자로 보내되, 채널 가입 유도를 함께 붙인다
    // (링크 미설정 시 유도는 생략하고 원본만 발송).
    const suffix = channelInviteSuffix(channelUrl);
    payload = { ...base, kind: 'direct', content: suffix ? `${content}\n\n${suffix}` : content };
    channel = 'invite_sms';
  }

  // 멱등: requestId 지정 시 create로 선점(존재 시 ALREADY_EXISTS) — directMessageHandler와 동일 패턴.
  if (data.requestId) {
    const ref = db.collection('message_queue').doc(String(data.requestId));
    try {
      await ref.create(payload);
    } catch (e) {
      if (e?.code === 6 || e?.code === 'already-exists' || /already.?exists/i.test(String(e?.message))) {
        return { queued: true, duplicate: true, channel, joined };
      }
      throw e;
    }
  } else {
    await db.collection('message_queue').doc().set(payload);
  }
  return { queued: true, channel, joined, scheduledDate: payload.scheduled_date ?? null };
}
