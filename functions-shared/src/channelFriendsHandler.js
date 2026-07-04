// 카카오 채널 친구(가입자) 명단. doc id = 정규화 전화번호.
// 카카오/솔라피가 친구 여부 사전조회를 주지 않으므로, BMS 발송 결과로 워커가 자동 학습한다
// (도달=추가, 비친구 3120=제거 — queueWorker). 수동 업로드 UI/callable은 사용법 혼란으로
// 제거함(2026-07-04) — 이 모듈은 발송 분기 판정(isChannelFriend)만 남긴다.
const COLL = 'kakao_channel_friends';

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');

// 전화번호가 채널 친구인지. dailyReportHandler가 발송 분기에 사용.
export async function isChannelFriend(db, phone) {
  const d = onlyDigits(phone);
  if (!d) return false;
  const snap = await db.collection(COLL).doc(d).get();
  return snap.exists;
}
