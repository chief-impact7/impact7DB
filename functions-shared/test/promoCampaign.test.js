import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>' },
}));

const {
  pickPromoPhone, buildPromoQueueDoc, buildPromoRecipients,
  assertAdContentCompliant, resolvePromoScheduledDate,
} = await import('../src/promoCampaignHandler.js');

const kst = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h - 9, mi));

describe('pickPromoPhone', () => {
  it('prefers parent_phone_1, then parent_phone_2', () => {
    expect(pickPromoPhone({ parent_phone_1: '010-1111-2222', parent_phone_2: '010-3' })).toBe('01011112222');
    expect(pickPromoPhone({ parent_phone_2: '010-222-3333' })).toBe('0102223333');
    expect(pickPromoPhone({})).toBe('');
  });
});

describe('buildPromoQueueDoc', () => {
  it('opted-in → SMS fallback allowed, marketing ad_flag, consent snapshot with source/at', () => {
    const d = buildPromoQueueDoc({
      studentId: 's1', phone: '01011112222', smsAllowed: true,
      consent: { source: 'diagnostic_form', at: '<ts>' },
      campaignId: 'c1', content: '(광고)x', targeting: 'M', scheduledDate: '2026-06-18 08:00:00',
    });
    expect(d.kind).toBe('promo');
    expect(d.disable_sms).toBe(false);
    expect(d.ad_flag).toBe(true);
    expect(d.scheduled_date).toBe('2026-06-18 08:00:00');
    expect(d.consent_snapshot).toEqual({ sms: true, source: 'diagnostic_form', at: '<ts>' });
  });

  it('no consent → BMS only, snapshot nulls', () => {
    const d = buildPromoQueueDoc({ studentId: 's1', phone: '010', smsAllowed: false, campaignId: 'c1', content: 'x' });
    expect(d.disable_sms).toBe(true);
    expect(d.consent_snapshot).toEqual({ sms: false, source: null, at: null });
  });

  it('informational targeting → ad_flag false', () => {
    const d = buildPromoQueueDoc({ studentId: 's1', phone: '010', smsAllowed: true, campaignId: 'c1', content: 'x', targeting: 'I' });
    expect(d.targeting).toBe('I');
    expect(d.ad_flag).toBe(false);
  });
});

describe('buildPromoRecipients (phone + opt-out + consent gating)', () => {
  it('excludes no-phone and revoked; counts SMS-eligible', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '010-1111-2222', message_consent: { promo: { optedIn: true } } } }, // 동의+번호
      { id: 's2', student: { parent_phone_1: '010-3333-4444' } }, // 번호만, 미동의 → BMS만
      { id: 's3', student: { name: '무번호' } }, // 번호 없음 → skip
      { id: 's4', student: { parent_phone_1: '010-5555-6666', message_consent: { promo: { optedIn: true, revokedAt: 1 } } } }, // 철회 → 전면 제외
    ];
    const { docs, stats } = buildPromoRecipients(entries, { campaignId: 'c1', content: '(광고)x', targeting: 'M' });
    expect(stats.total).toBe(4);
    expect(stats.queued).toBe(2); // s1, s2
    expect(stats.skipped_no_phone).toBe(1); // s3
    expect(stats.skipped_revoked).toBe(1); // s4
    expect(stats.sms_allowed).toBe(1); // s1
    expect(docs.find((d) => d.student_id === 's1').disable_sms).toBe(false);
    expect(docs.find((d) => d.student_id === 's2').disable_sms).toBe(true);
    expect(docs.find((d) => d.student_id === 's4')).toBeUndefined(); // 옵트아웃 → 큐에 없음
  });
});

describe('assertAdContentCompliant (정보통신망법 §50)', () => {
  it('passes ad content with (광고) + opt-out notice', () => {
    expect(() => assertAdContentCompliant('(광고)[임팩트세븐학원] 특강\n무료거부 080-123-4567', 'M')).not.toThrow();
  });
  it('rejects ad content missing (광고)', () => {
    expect(() => assertAdContentCompliant('[학원] 특강 무료거부 080', 'M')).toThrow();
  });
  it('rejects ad content missing opt-out', () => {
    expect(() => assertAdContentCompliant('(광고)[학원] 특강 안내', 'M')).toThrow();
  });
  it('skips the check for informational (I) messages', () => {
    expect(() => assertAdContentCompliant('성적 안내드립니다', 'I')).not.toThrow();
  });
});

describe('resolvePromoScheduledDate (night ad guard)', () => {
  it('returns null for daytime with no scheduledAt (immediate send)', () => {
    expect(resolvePromoScheduledDate(null, kst(2026, 6, 17, 14, 0))).toBeNull();
  });
  it('auto-defers a night "now" to next 08:00', () => {
    expect(resolvePromoScheduledDate(null, kst(2026, 6, 17, 22, 0))).toBe('2026-06-18 08:00:00');
  });
  it('keeps a daytime scheduledAt unchanged', () => {
    expect(resolvePromoScheduledDate('2026-06-18 14:00:00', kst(2026, 6, 17, 14, 0))).toBe('2026-06-18 14:00:00');
  });
  it('corrects a night scheduledAt to next 08:00 (no bypass)', () => {
    expect(resolvePromoScheduledDate('2026-06-18 23:00:00', kst(2026, 6, 17, 14, 0))).toBe('2026-06-19 08:00:00');
  });
  it('rejects a malformed scheduledAt', () => {
    expect(() => resolvePromoScheduledDate('not-a-date', kst(2026, 6, 17, 14, 0))).toThrow();
  });
});
