import { describe, it, expect } from 'vitest';
import { resolveChannelAddUrl, channelInviteSuffix, DEFAULT_CHANNEL_ADD_URL } from '../src/channelInvite.js';

describe('channelInvite', () => {
  it('resolveChannelAddUrl: overrides > 기본값, 빈 문자열도 명시값으로 존중', () => {
    expect(resolveChannelAddUrl({ channelAddUrl: 'https://x' })).toBe('https://x');
    expect(resolveChannelAddUrl()).toBe(DEFAULT_CHANNEL_ADD_URL);
    expect(resolveChannelAddUrl({ channelAddUrl: '' })).toBe(''); // 링크 미설정 발송 차단이 가능하도록 '' 유지
  });

  it('channelInviteSuffix: 채널 링크 + 가입 유도 안내를 포함', () => {
    const s = channelInviteSuffix('https://kakao.impact7.kr');
    expect(s).toContain('https://kakao.impact7.kr');
    expect(s).toContain('채널 추가');
  });

  it('channelInviteSuffix: 링크가 비면 빈 문자열(깨진 문구 방지)', () => {
    expect(channelInviteSuffix('')).toBe('');
    expect(channelInviteSuffix(undefined)).toBe('');
  });
});
