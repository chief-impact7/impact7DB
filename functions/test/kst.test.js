import { describe, it, expect } from 'vitest';
import { todayKST } from '../src/kst.js';

describe('todayKST', () => {
  it('YYYY-MM-DD 형식', () => {
    expect(todayKST()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
