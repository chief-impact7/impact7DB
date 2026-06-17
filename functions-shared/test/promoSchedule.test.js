import { describe, it, expect } from 'vitest';
import { isAdNightKST, resolveAdScheduledAt } from '../src/promoSchedule.js';

// KST 벽시계 h:mi에 해당하는 UTC Date 생성 (KST = UTC+9).
function kst(y, mo, d, h, mi = 0) {
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi));
}

describe('isAdNightKST', () => {
  it('treats 20:50~08:00 KST as ad-restricted', () => {
    expect(isAdNightKST(kst(2026, 6, 16, 22, 0))).toBe(true); // 저녁
    expect(isAdNightKST(kst(2026, 6, 16, 3, 0))).toBe(true); // 새벽
    expect(isAdNightKST(kst(2026, 6, 16, 20, 50))).toBe(true); // 경계 시작
    expect(isAdNightKST(kst(2026, 6, 16, 7, 59))).toBe(true); // 아침 직전
  });

  it('treats 08:00~20:49 KST as sendable', () => {
    expect(isAdNightKST(kst(2026, 6, 16, 14, 0))).toBe(false); // 주간
    expect(isAdNightKST(kst(2026, 6, 16, 8, 0))).toBe(false); // 경계(허용)
    expect(isAdNightKST(kst(2026, 6, 16, 20, 49))).toBe(false); // 제한 직전
  });
});

describe('resolveAdScheduledAt', () => {
  it('returns null in daytime (immediate send)', () => {
    expect(resolveAdScheduledAt(kst(2026, 6, 16, 14, 0))).toBeNull();
    expect(resolveAdScheduledAt(kst(2026, 6, 16, 8, 0))).toBeNull();
  });

  it('schedules evening sends to next day 08:00 KST', () => {
    expect(resolveAdScheduledAt(kst(2026, 6, 16, 22, 30))).toBe('2026-06-17 08:00:00');
    expect(resolveAdScheduledAt(kst(2026, 6, 16, 20, 50))).toBe('2026-06-17 08:00:00');
  });

  it('schedules early-morning sends to same day 08:00 KST', () => {
    expect(resolveAdScheduledAt(kst(2026, 6, 17, 3, 0))).toBe('2026-06-17 08:00:00');
  });

  it('rolls over month/year boundaries', () => {
    expect(resolveAdScheduledAt(kst(2026, 6, 30, 23, 0))).toBe('2026-07-01 08:00:00');
    expect(resolveAdScheduledAt(kst(2026, 12, 31, 23, 0))).toBe('2027-01-01 08:00:00');
  });
});
