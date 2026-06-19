import { describe, it, expect } from 'vitest';
import { resolveRecipientPhone, resolveRecipientPhones } from '../src/recipientPhone.js';

const student = {
  student_phone: '010-1111-1111',
  parent_phone_1: '010-2222-2222',
  parent_phone_2: '010-3333-3333',
  other_phone: '010-4444-4444',
};

describe('resolveRecipientPhone', () => {
  it('selects the requested target field', () => {
    expect(resolveRecipientPhone(student, 'student')).toBe('01011111111');
    expect(resolveRecipientPhone(student, 'parent_1')).toBe('01022222222');
    expect(resolveRecipientPhone(student, 'parent_2')).toBe('01033333333');
    expect(resolveRecipientPhone(student, 'other')).toBe('01044444444');
  });

  it('falls back to parent_1 then parent_2 when field is unset', () => {
    expect(resolveRecipientPhone(student, undefined)).toBe('01022222222');
    expect(resolveRecipientPhone({ parent_phone_2: '010-9999-9999' }, undefined)).toBe('01099999999');
  });

  it('falls back when the requested field is empty', () => {
    expect(resolveRecipientPhone({ parent_phone_1: '010-2222-2222' }, 'student')).toBe('01022222222');
  });

  it('returns empty string when nothing is available', () => {
    expect(resolveRecipientPhone({}, 'student')).toBe('');
    expect(resolveRecipientPhone(null, 'parent_1')).toBe('');
  });
});

describe('resolveRecipientPhones', () => {
  it('요청한 fields 순서대로 번호 배열을 반환한다', () => {
    expect(resolveRecipientPhones(student, ['student', 'parent_1'])).toEqual(['01011111111', '01022222222']);
    expect(resolveRecipientPhones(student, ['parent_2', 'other'])).toEqual(['01033333333', '01044444444']);
  });

  it('빈 번호·알 수 없는 field는 제외한다', () => {
    const s = { student_phone: '010-1111-1111' };
    expect(resolveRecipientPhones(s, ['student', 'parent_1', 'unknown'])).toEqual(['01011111111']);
  });

  it('번호가 없는 학생은 빈 배열을 반환한다', () => {
    expect(resolveRecipientPhones({}, ['parent_1', 'parent_2'])).toEqual([]);
    expect(resolveRecipientPhones(null, ['parent_1'])).toEqual([]);
  });

  it('같은 번호가 여러 field에 있어도 모두 반환(dedup은 호출자 담당)', () => {
    const s = { parent_phone_1: '01011112222', parent_phone_2: '01011112222' };
    expect(resolveRecipientPhones(s, ['parent_1', 'parent_2'])).toEqual(['01011112222', '01011112222']);
  });
});
