import { describe, it, expect } from 'vitest';
import { previousDateKST, todayKST } from '../src/kst.js';

describe('todayKST', () => {
  it('YYYY-MM-DD 형식', () => {
    expect(todayKST()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('previousDateKST', () => {
  it('월·연도 경계를 포함해 전날 문자열을 반환한다', () => {
    expect(previousDateKST('2026-01-01')).toBe('2025-12-31');
    expect(previousDateKST('2024-03-01')).toBe('2024-02-29');
  });
});
