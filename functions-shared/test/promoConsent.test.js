import { describe, it, expect } from 'vitest';
import { canReceivePromoSms, getPromoConsent, promoEligibility } from '../src/promoConsent.js';

describe('promoConsent', () => {
  it('reads the promo consent map', () => {
    expect(getPromoConsent({ message_consent: { promo: { optedIn: true } } })).toEqual({ optedIn: true });
    expect(getPromoConsent({})).toBeNull();
    expect(getPromoConsent(null)).toBeNull();
  });

  it('allows SMS fallback only for opted-in, non-revoked students', () => {
    expect(canReceivePromoSms({ message_consent: { promo: { optedIn: true } } })).toBe(true);
  });

  it('blocks SMS fallback when not opted in or consent absent', () => {
    expect(canReceivePromoSms({ message_consent: { promo: { optedIn: false } } })).toBe(false);
    expect(canReceivePromoSms({})).toBe(false);
    expect(canReceivePromoSms(null)).toBe(false);
  });

  it('blocks SMS fallback when revoked even if opted in', () => {
    expect(canReceivePromoSms({ message_consent: { promo: { optedIn: true, revokedAt: new Date() } } })).toBe(false);
  });

  it('promoEligibility reports a skip reason', () => {
    expect(promoEligibility({}).reason).toBe('no_consent');
    expect(promoEligibility({ message_consent: { promo: { optedIn: true, revokedAt: 1 } } }).reason).toBe('revoked');
    expect(promoEligibility({ message_consent: { promo: { optedIn: true } } })).toEqual({
      smsFallbackAllowed: true,
      reason: null,
    });
  });
});

describe('대상별 동의 분리 (parent=promo / student=promo_student)', () => {
  it('학생 동의만 있으면 student 대상만 허용된다', async () => {
    const { canReceivePromoSms, promoEligibility, consentTargetOf } = await import('../src/promoConsent.js');
    const student = { message_consent: { promo_student: { optedIn: true, revokedAt: null } } };
    expect(canReceivePromoSms(student, 'student')).toBe(true);
    expect(canReceivePromoSms(student, 'parent')).toBe(false);
    expect(promoEligibility(student, 'parent').reason).toBe('no_consent');
    expect(consentTargetOf('student')).toBe('student');
    expect(consentTargetOf('parent_1')).toBe('parent');
    expect(consentTargetOf(undefined)).toBe('parent');
  });
});
