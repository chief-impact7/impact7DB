import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));

const { isReconfirmDue, runPromoConsentReconfirm } = await import('../src/promoConsentReconfirm.js');

const now = new Date('2026-06-17T00:00:00Z');
const yearsAgo = (n) => new Date(now.getTime() - n * 365 * 24 * 60 * 60 * 1000);

describe('isReconfirmDue', () => {
  it('true when opted-in and consent older than 2 years, never notified', () => {
    expect(isReconfirmDue({ optedIn: true, at: yearsAgo(2.1) }, now)).toBe(true);
  });
  it('false when consent younger than 2 years', () => {
    expect(isReconfirmDue({ optedIn: true, at: yearsAgo(1) }, now)).toBe(false);
  });
  it('false when not opted in or revoked', () => {
    expect(isReconfirmDue({ optedIn: false, at: yearsAgo(3) }, now)).toBe(false);
    expect(isReconfirmDue({ optedIn: true, at: yearsAgo(3), revokedAt: yearsAgo(1) }, now)).toBe(false);
    expect(isReconfirmDue(null, now)).toBe(false);
  });
  it('false when last notification is within 2 years', () => {
    expect(isReconfirmDue({ optedIn: true, at: yearsAgo(3), lastNotifiedAt: yearsAgo(1) }, now)).toBe(false);
  });
  it('true again when last notification is also older than 2 years', () => {
    expect(isReconfirmDue({ optedIn: true, at: yearsAgo(5), lastNotifiedAt: yearsAgo(2.1) }, now)).toBe(true);
  });
  it('accepts firestore Timestamp-like (toDate)', () => {
    const ts = { toDate: () => yearsAgo(2.5) };
    expect(isReconfirmDue({ optedIn: true, at: ts }, now)).toBe(true);
  });
});

describe('runPromoConsentReconfirm', () => {
  function makeDb(students) {
    const q = { where() { return q; }, async get() { return { docs: students.map((s, i) => ({ id: `s${i}`, data: () => s })) }; } };
    return { collection: () => q };
  }
  it('counts only due opted-in students', async () => {
    const db = makeDb([
      { message_consent: { promo: { optedIn: true, at: yearsAgo(3) } } }, // due
      { message_consent: { promo: { optedIn: true, at: yearsAgo(1) } } }, // 최근 동의 → 아님
      { message_consent: { promo: { optedIn: true, at: yearsAgo(3), lastNotifiedAt: yearsAgo(0.5) } } }, // 최근 통지 → 아님
    ]);
    const res = await runPromoConsentReconfirm({ db, now });
    expect(res.due).toBe(1);
    expect(res.dueIds).toEqual(['s0']);
  });
});
