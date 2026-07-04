// 카카오 채널 가입 유도 — 미가입(비친구) 학부모를 채널 친구로 유도하는 공용 링크/문구.
// 순수 모듈(외부 의존 없음)이라 콜드스타트 부담 없이 정적 import 가능. dailyReportHandler(사전
// 비친구 판별)와 queueWorker(BMS 미도달 문자 전환)가 링크를 공유한다(SSOT).

// 채널 추가 링크 — 비밀이 아니므로 코드 기본값으로 고정(pfId와 동일 정책). env로 override 가능.
// talk.impact7.kr/kakao → pf.kakao.com/_xjxfqbn(채널 홈) 리다이렉트 확인(2026-07-04).
export const DEFAULT_CHANNEL_ADD_URL = 'https://talk.impact7.kr/kakao';

// deps.channelAddUrl > env(KAKAO_CHANNEL_ADD_URL) > 기본값 순으로 채널 링크를 해석한다.
export function resolveChannelAddUrl(overrides = {}) {
  return overrides.channelAddUrl ?? process.env.KAKAO_CHANNEL_ADD_URL ?? DEFAULT_CHANNEL_ADD_URL;
}

// BMS 미도달(비친구)로 문자 전환된 안내 뒤에 덧붙이는 채널 가입 안내.
// 정보성 톤 — 문자로 온 이유(채널 미가입)를 고지하고 카톡 수신 방법을 안내한다(혜택 소구·권유 아님).
// 링크가 비어 있으면(운영값 미설정) "→ " 깨진 문구가 나가지 않도록 부착을 생략한다.
export function channelInviteSuffix(channelUrl) {
  if (!channelUrl) return '';
  return `카카오톡 채널 미가입으로 문자 안내드립니다. 자유로운 소통은 채널 가입으로 가능합니다. → ${channelUrl}`;
}
