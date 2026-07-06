import { describe, it, expect } from 'vitest';

const { handleGetRecipientMessageHistory, mapQueueDoc } = await import('../src/messageHistoryHandler.js');

const auth = { uid: 'u1', token: { email: 'teacher@impact7.kr' } };

function makeDb(rows) {
  function makeChain(filters) {
    const match = () => rows.filter((r) => filters.every(([f, v]) => r[f] === v));
    return {
      where(f, _op, v) { return makeChain([...filters, [f, v]]); },
      orderBy() { return makeChain(filters); },
      limit(n) { const c = makeChain(filters); c._limit = n; return c; },
      async get() {
        return { docs: match().map((r) => ({ id: r.id, data: () => r })) };
      },
    };
  }
  return { collection: () => makeChain([]) };
}

describe('handleGetRecipientMessageHistory', () => {
  it('requires auth', async () => {
    await expect(handleGetRecipientMessageHistory({ data: { studentId: 's1' } }, { db: makeDb([]) }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('requires studentId or phone', async () => {
    await expect(handleGetRecipientMessageHistory({ auth, data: {} }, { db: makeDb([]) }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an invalid phone', async () => {
    await expect(handleGetRecipientMessageHistory({ auth, data: { phone: '12' } }, { db: makeDb([]) }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('returns queue docs for a student — masked phone, no plaintext', async () => {
    const rows = [
      {
        id: 'q1', student_id: 's1', kind: 'attendance', status: 'sent',
        template_code: 'TPL1', fallback_text: '홍길동 학생이 등원하였습니다.',
        recipient_phone: '01011112222', recipient_role: 'parent_2', last_error_code: null,
        created_at: { toMillis: () => 100 }, updated_at: { toMillis: () => 200 },
      },
      { id: 'q2', student_id: 's2', kind: 'direct', status: 'sent', content: '다른 학생', recipient_phone: '01033334444' },
    ];
    const res = await handleGetRecipientMessageHistory({ auth, data: { studentId: 's1' } }, { db: makeDb(rows) });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: 'q1',
      kind: 'attendance',
      status: 'sent',
      content: '홍길동 학생이 등원하였습니다.',
      recipientRole: 'parent_2',
      createdAt: 100,
      piiPurged: false,
    });
    expect(JSON.stringify(res.items)).not.toContain('01011112222');
    expect(res.items[0].recipientMasked).toMatch(/\*/);
  });

  it('searches by normalized phone (비학생 수신자)', async () => {
    const rows = [
      { id: 'q1', kind: 'parent_bms', status: 'converted_to_sms', content: '진단평가 안내', recipient_phone: '01055556666' },
    ];
    const res = await handleGetRecipientMessageHistory({ auth, data: { phone: '010-5555-6666' } }, { db: makeDb(rows) });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].content).toBe('진단평가 안내');
  });

  it('marks purged docs and keeps the stored mask', () => {
    const item = mapQueueDoc('q1', {
      kind: 'attendance', status: 'sent', recipient_masked: '010****2222',
      pii_purged_at: { toMillis: () => 1 },
    });
    expect(item).toMatchObject({ piiPurged: true, content: null, recipientMasked: '010****2222' });
  });
});
