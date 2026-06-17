import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>', delete: () => '<delete>' },
}));

const { __testing } = await import('../src/queueWorker.js');

describe('queueWorker promo routing (P4)', () => {
  it('allows the promo kind through the worker', () => {
    expect(__testing.ALLOWED_KINDS.has('promo')).toBe(true);
    expect(__testing.ALLOWED_KINDS.has('attendance')).toBe(true);
  });

  it('maps a promo queue doc to a brand-message payload', () => {
    const p = __testing.buildSendPayload({
      kind: 'promo',
      recipient_phone: '01011112222',
      content: '(광고)[임팩트세븐학원] 여름 특강',
      buttons: [{ buttonType: 'WL', buttonName: '신청', linkMo: 'https://m' }],
      image_id: 'IMG1',
      ad_flag: true,
      disable_sms: false, // 동의자 → SMS 대체 허용
      targeting: 'M',
      scheduled_date: '2026-06-18 08:00:00',
    });
    expect(p.content).toContain('광고');
    expect(p.buttons).toHaveLength(1);
    expect(p.imageId).toBe('IMG1');
    expect(p.adFlag).toBe(true);
    expect(p.disableSms).toBe(false);
    expect(p.targeting).toBe('M');
    expect(p.scheduledDate).toBe('2026-06-18 08:00:00');
    expect(p.templateCode).toBeUndefined();
  });

  it('defaults promo disable_sms to true (BMS-only) when not opted in', () => {
    const p = __testing.buildSendPayload({ kind: 'promo', recipient_phone: '010', content: 'x' });
    expect(p.disableSms).toBe(true); // 미동의 기본 → SMS 대체 안 함
    expect(p.adFlag).toBe(true);
    expect(p.targeting).toBe('M');
  });

  it('still maps non-promo kinds to the template payload', () => {
    const p = __testing.buildSendPayload({
      kind: 'attendance',
      recipient_phone: '01011112222',
      template_code: 'TMPL_1',
      template_variables: { '#{학생명}': '김학생' },
      fallback_text: '대체',
    });
    expect(p.templateCode).toBe('TMPL_1');
    expect(p.templateVariables).toEqual({ '#{학생명}': '김학생' });
    expect(p.content).toBeUndefined();
  });
});
