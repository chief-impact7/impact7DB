import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>' },
}));

const { buildPromoConsentPatch, handleSetPromoConsent } = await import('../src/promoConsentHandler.js');

describe('buildPromoConsentPatch', () => {
  it('opt-in records consent with no revocation', () => {
    const p = buildPromoConsentPatch({ optedIn: true, source: 'diagnostic_form' });
    expect(p.optedIn).toBe(true);
    expect(p.source).toBe('diagnostic_form');
    expect(p.revokedAt).toBeNull();
  });

  it('opt-out records revokedAt timestamp', () => {
    const p = buildPromoConsentPatch({ optedIn: false, source: 'admin' });
    expect(p.optedIn).toBe(false);
    expect(p.revokedAt).toBe('<ts>');
  });

  it('falls back to admin source for unknown values', () => {
    expect(buildPromoConsentPatch({ optedIn: true, source: 'hacker' }).source).toBe('admin');
  });
});

describe('handleSetPromoConsent', () => {
  function makeDb() {
    const writes = [];
    return {
      writes,
      collection: () => ({
        doc: (id) => ({ set: async (data, opts) => writes.push({ id, data, opts }) }),
      }),
    };
  }
  const auth = { uid: 'u1', token: { email: 'teacher@impact7.kr', email_verified: true } };

  it('writes merged consent for an authorized staff member (기본 target=parent → promo)', async () => {
    const db = makeDb();
    const res = await handleSetPromoConsent({ auth, data: { studentId: 's1', optedIn: true, source: 'diagnostic_form' } }, { db });
    expect(res).toMatchObject({ studentId: 's1', target: 'parent', optedIn: true, source: 'diagnostic_form' });
    expect(db.writes[0].opts).toEqual({ merge: true });
    expect(db.writes[0].data.message_consent.promo.optedIn).toBe(true);
  });

  it('target=student → promo_student 필드에 기록(보호자 동의와 분리)', async () => {
    const db = makeDb();
    const res = await handleSetPromoConsent({ auth, data: { studentId: 's1', optedIn: false, target: 'student' } }, { db });
    expect(res).toMatchObject({ studentId: 's1', target: 'student', optedIn: false });
    const mc = db.writes[0].data.message_consent;
    expect(mc.promo_student.optedIn).toBe(false);
    expect(mc.promo_student.revokedAt).toBe('<ts>');
    expect(mc.promo).toBeUndefined();
  });

  it('rejects missing studentId', async () => {
    const db = makeDb();
    await expect(handleSetPromoConsent({ auth, data: { optedIn: true } }, { db })).rejects.toThrow();
  });

  it('rejects non-boolean optedIn', async () => {
    const db = makeDb();
    await expect(handleSetPromoConsent({ auth, data: { studentId: 's1' } }, { db })).rejects.toThrow();
  });

  it('rejects unauthorized (non-staff) caller', async () => {
    const db = makeDb();
    const outsider = { uid: 'x', token: { email: 'someone@gmail.com', email_verified: true } };
    await expect(handleSetPromoConsent({ auth: outsider, data: { studentId: 's1', optedIn: true } }, { db })).rejects.toThrow();
  });
});
