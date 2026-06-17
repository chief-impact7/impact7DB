import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));

const { toIso, mapMessageLog, handleGetStudentMessages } = await import('../src/studentMessagesHandler.js');

describe('toIso / mapMessageLog', () => {
  it('converts firestore timestamp and passes strings through', () => {
    expect(toIso({ toDate: () => new Date('2026-06-17T01:00:00Z') })).toBe('2026-06-17T01:00:00.000Z');
    expect(toIso('2026-06-17')).toBe('2026-06-17');
    expect(toIso(null)).toBeNull();
  });

  it('maps a log to view shape without leaking the plaintext phone', () => {
    const m = mapMessageLog('l1', {
      kind: 'parent_notice', status: 'sent', channel: 'kakao', status_code: '2000',
      recipient_phone: '01067327774',
      request_summary: { template_code: 'T', recipient_masked: '***-****-7774' },
      created_at: { toDate: () => new Date('2026-06-17T01:00:00Z') },
    });
    expect(m).toMatchObject({ id: 'l1', kind: 'parent_notice', status: 'sent', channel: 'kakao', templateCode: 'T', recipientMasked: '***-****-7774' });
    expect(m.createdAt).toBe('2026-06-17T01:00:00.000Z');
    expect(JSON.stringify(m)).not.toContain('01067327774'); // 평문 번호 미노출
  });
});

describe('handleGetStudentMessages', () => {
  const auth = { uid: 'u1', token: { email: 't@impact7.kr', email_verified: true } };
  function makeDb(docs) {
    const q = {
      where() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      async get() { return { docs: docs.map((d, i) => ({ id: `l${i}`, data: () => d })) }; },
    };
    return { collection: () => q };
  }

  it('returns mapped logs for authorized staff', async () => {
    const db = makeDb([{ kind: 'promo', status: 'sent', channel: 'kakao', created_at: { toDate: () => new Date() } }]);
    const res = await handleGetStudentMessages({ auth, data: { studentId: 's1' } }, { db });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].kind).toBe('promo');
  });

  it('rejects a missing studentId', async () => {
    await expect(handleGetStudentMessages({ auth, data: {} }, { db: makeDb([]) })).rejects.toThrow();
  });

  it('rejects an unauthorized caller', async () => {
    const outsider = { uid: 'x', token: { email: 'x@gmail.com', email_verified: true } };
    await expect(handleGetStudentMessages({ auth: outsider, data: { studentId: 's1' } }, { db: makeDb([]) })).rejects.toThrow();
  });
});
