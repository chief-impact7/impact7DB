import { describe, it, expect } from 'vitest';
import { resolveChannelAddUrl, channelInviteSuffix, DEFAULT_CHANNEL_ADD_URL } from '../src/channelInvite.js';

describe('channelInvite', () => {
  it('resolveChannelAddUrl: overrides > 기본값, 빈 문자열도 명시값으로 존중', () => {
    expect(resolveChannelAddUrl({ channelAddUrl: 'https://x' })).toBe('https://x');
    expect(resolveChannelAddUrl()).toBe(DEFAULT_CHANNEL_ADD_URL);
    expect(resolveChannelAddUrl({ channelAddUrl: '' })).toBe(''); // 링크 미설정 발송 차단이 가능하도록 '' 유지
  });

  it('channelInviteSuffix: 채널 링크 + 정보성 안내(미가입 고지·가입 유도)를 포함', () => {
    const s = channelInviteSuffix('https://talk.impact7.kr/kakao');
    expect(s).toContain('https://talk.impact7.kr/kakao');
    expect(s).toContain('채널 가입');
    expect(s).toContain('미가입');
  });

  it('channelInviteSuffix: 링크가 비면 빈 문자열(깨진 문구 방지)', () => {
    expect(channelInviteSuffix('')).toBe('');
    expect(channelInviteSuffix(undefined)).toBe('');
  });
});

describe('loadChannelInviteText', () => {
  const dbWith = (data) => ({ collection: () => ({ doc: () => ({ get: async () => ({ data: () => data }) }) }) });

  it('운영자 설정(channel_invite)이 있으면 그것을 쓴다', async () => {
    const { loadChannelInviteText } = await import('../src/channelInvite.js');
    expect(await loadChannelInviteText(dbWith({ channel_invite: '커스텀 안내 문구' }))).toBe('커스텀 안내 문구');
  });

  it('설정이 없거나 조회 실패면 기본 문구', async () => {
    const { loadChannelInviteText } = await import('../src/channelInvite.js');
    expect(await loadChannelInviteText(dbWith({}))).toContain('talk.impact7.kr/kakao');
    expect(await loadChannelInviteText({ collection: () => { throw new Error('down'); } })).toContain('talk.impact7.kr/kakao');
  });
});
