import { describe, test, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));

import { isAuthorizedStaffEmail, assertAuthorizedStaff } from '../src/authGuards.js';

describe('isAuthorizedStaffEmail', () => {
  test('학원 도메인은 항상 허용', () => {
    expect(isAuthorizedStaffEmail('a@impact7.kr')).toBe(true);
    expect(isAuthorizedStaffEmail('b@gw.impact7.kr')).toBe(true);
  });

  test('외부 계정·빈값 거부', () => {
    expect(isAuthorizedStaffEmail('x@gmail.com')).toBe(false);
    expect(isAuthorizedStaffEmail('')).toBe(false);
    expect(isAuthorizedStaffEmail(undefined)).toBe(false);
  });

  test('키오스크 계정은 allowKiosk에서만 허용', () => {
    expect(isAuthorizedStaffEmail('impact7enf@gmail.com')).toBe(false);
    expect(isAuthorizedStaffEmail('impact7enf@gmail.com', { allowKiosk: true })).toBe(true);
    // 화이트리스트 밖 gmail은 allowKiosk여도 거부
    expect(isAuthorizedStaffEmail('other@gmail.com', { allowKiosk: true })).toBe(false);
  });
});

describe('assertAuthorizedStaff', () => {
  const tok = (email) => ({ token: { email, email_verified: true } });

  test('미인증은 unauthenticated', () => {
    expect(() => assertAuthorizedStaff(null)).toThrow(/로그인/);
  });

  test('학원 도메인 통과', () => {
    expect(() => assertAuthorizedStaff(tok('a@impact7.kr'))).not.toThrow();
  });

  test('키오스크 계정은 allowKiosk 한정 통과(기본은 거부)', () => {
    expect(() => assertAuthorizedStaff(tok('impact7enf@gmail.com'))).toThrow();
    expect(() => assertAuthorizedStaff(tok('impact7enf@gmail.com'), { allowKiosk: true })).not.toThrow();
  });

  test('화이트리스트 밖 외부 계정은 allowKiosk여도 거부', () => {
    expect(() => assertAuthorizedStaff(tok('other@gmail.com'), { allowKiosk: true })).toThrow();
  });
});
