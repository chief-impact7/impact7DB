import { describe, it, expect } from 'vitest';
import { resolveRecipientPhone } from '../src/recipientPhone.js';

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
