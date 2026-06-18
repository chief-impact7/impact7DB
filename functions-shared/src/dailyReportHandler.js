import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { resolveRecipientPhone } from './recipientPhone.js';
import { isChannelFriend } from './channelFriendsHandler.js';

// 채널 미가입 학부모에게 보내는 가입 안내 SMS. 채널 추가 링크는 운영값(env/deps)으로 주입한다.
function inviteSms(channelUrl) {
  return `[임팩트세븐학원] 자녀의 일일 학습현황을 카카오톡으로 보내드립니다.\n아래 채널을 추가해 주세요 → ${channelUrl}`;
}

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
  const channelUrl = deps.channelAddUrl ?? process.env.KAKAO_CHANNEL_ADD_URL ?? '';

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
    channel = 'report';
  } else {
    // 가입 링크 미설정 시 깨진 안내문 발송을 막는다(운영값 KAKAO_CHANNEL_ADD_URL 필요).
    if (!channelUrl) throw new HttpsError('failed-precondition', '채널 가입 링크가 설정되지 않아 가입 안내를 보낼 수 없습니다.');
    payload = { ...base, kind: 'direct', content: inviteSms(channelUrl) };
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
  return { queued: true, channel, joined };
}
