import { describe, it, expect } from 'vitest';
import { isoWeekKST } from '../src/isoWeek.js';

describe('isoWeekKST', () => {
  it('평일 — 자기 해 주차로 귀속', () => {
    expect(isoWeekKST('2026-07-17')).toBe('2026-W29'); // 금요일
  });

  it('연초 목요일 — 자기 해 1주차', () => {
    expect(isoWeekKST('2026-01-01')).toBe('2026-W01'); // 목요일
  });

  it('연말 월요일 — 다음 해 1주차로 귀속', () => {
    expect(isoWeekKST('2019-12-30')).toBe('2020-W01'); // 월요일
  });

  it('연초 금요일 — 전년도 53주차로 귀속', () => {
    expect(isoWeekKST('2021-01-01')).toBe('2020-W53'); // 금요일
  });

  it('53주까지 있는 해의 마지막 주', () => {
    expect(isoWeekKST('2020-12-31')).toBe('2020-W53'); // 목요일
  });

  it('같은 ISO 주(월~일)의 날짜는 동일한 키를 반환', () => {
    const monday = isoWeekKST('2026-07-13');
    const sunday = isoWeekKST('2026-07-19');
    expect(sunday).toBe(monday);
    expect(monday).toBe('2026-W29');
  });
});
