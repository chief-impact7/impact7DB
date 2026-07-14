import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const { parseRecipients, handleSendDirectMessage } = await import('../src/directMessageHandler.js');

function makeDb() {
  const docs = {};
  let counter = 0;
  const col = (name) => ({
    doc: (id) => {
      const resolvedId = id ?? `auto_${counter++}`;
      const key = `${name}/${resolvedId}`;
      return {
        id: resolvedId,
        async get() { return { exists: key in docs, data: () => docs[key] }; },
        async set(v) { docs[key] = v; },
        async create(v) {
          if (key in docs) {
            const err = new Error('ALREADY_EXISTS');
            err.code = 6;
            throw err;
          }
          docs[key] = v;
        },
      };
    },
    async add(v) { const id = `auto_${counter++}`; docs[`${name}/${id}`] = v; return { id }; },
  });
  return { _docs: docs, collection: col, batch: () => { const ops = []; return { set: (ref, v) => ops.push({ type: 'set', ref, v }), create: (ref, v) => ops.push({ type: 'create', ref, v }), async commit() { for (const op of ops) { if (op.type === 'create') await op.ref.create(op.v); else await op.ref.set(op.v); } } }; } };
}

const auth = { token: { email: 'staff@impact7.kr' } };

describe('parseRecipients', () => {
  it('splits on newline/comma, keeps 9-11 digit numbers, dedupes', () => {
    const r = parseRecipients('010-1234-5678\n010-1234-5678, 02-2649-0509\nabc, 123');
    expect(r.valid).toEqual(['01012345678', '0226490509']);
    expect(r.invalid).toContain('123');
  });
});

describe('handleSendDirectMessage', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  it('enqueues one direct queue doc per valid number', async () => {
    const res = await handleSendDirectMessage({ auth, data: { recipients: '01011112222\n01033334444', text: '안내' } }, { db });
    expect(res.queued).toBe(2);
    const directDocs = Object.values(db._docs).filter((d) => d.kind === 'direct');
    expect(directDocs).toHaveLength(2);
    expect(directDocs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'direct', status: 'pending', content: '안내', recipient_phone: '01011112222' }),
    ]));
  });

  it('rejects empty text', async () => {
    await expect(handleSendDirectMessage({ auth, data: { recipients: '01011112222', text: '  ' } }, { db })).rejects.toThrow();
  });

  it('rejects when no valid recipients', async () => {
    await expect(handleSendDirectMessage({ auth, data: { recipients: 'abc', text: 'x' } }, { db })).rejects.toThrow();
  });

  it('is idempotent on requestId (no double enqueue)', async () => {
    const data = { recipients: '01011112222', text: '안내', requestId: 'req-1' };
    await handleSendDirectMessage({ auth, data }, { db });
    const second = await handleSendDirectMessage({ auth, data }, { db });
    expect(second.duplicate).toBe(true);
    expect(Object.values(db._docs).filter((d) => d.kind === 'direct')).toHaveLength(1);
  });

  it('rejects more than MAX_RECIPIENTS recipients', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `010${String(i).padStart(8, '0')}`).join('\n');
    await expect(handleSendDirectMessage({ auth, data: { recipients: many, text: 'x' } }, { db })).rejects.toThrow();
  });

  it('propagates scheduledAt to scheduled_date', async () => {
    await handleSendDirectMessage({ auth, data: { recipients: '01011112222', text: '안내', scheduledAt: '2026-07-01T09:00:00+09:00' } }, { db });
    const doc = Object.values(db._docs).find((d) => d.kind === 'direct');
    expect(doc.scheduled_date).toBe('2026-07-01T09:00:00+09:00');
  });

  it('sets scheduled_date to null when scheduledAt is omitted', async () => {
    await handleSendDirectMessage({ auth, data: { recipients: '01011112222', text: '안내' } }, { db });
    const doc = Object.values(db._docs).find((d) => d.kind === 'direct');
    expect(doc.scheduled_date).toBeNull();
  });

  it('enqueues compliant promotional messages with a manual consent snapshot', async () => {
    const now = new Date('2026-07-14T01:00:00.000Z');
    await handleSendDirectMessage({
      auth,
      data: {
        recipients: '01011112222',
        text: '(광고) [임팩트세븐학원]\n여름 특강\n무료수신거부 080-500-4233',
        messageKind: 'promo',
        consentConfirmed: true,
      },
    }, { db, now });
    const doc = Object.values(db._docs).find((d) => d.kind === 'promo_sms');
    expect(doc).toMatchObject({
      ad_flag: true,
      consent_snapshot: { sms: true, source: 'manual_confirmation', at: now.toISOString() },
    });
  });

  it('rejects promotional messages without consent confirmation or required labels', async () => {
    await expect(handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text: '(광고) 안내\n수신거부 080', messageKind: 'promo' },
    }, { db })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text: '안내', messageKind: 'promo', consentConfirmed: true },
    }, { db })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an unknown message kind', async () => {
    await expect(handleSendDirectMessage({
      auth,
      data: { recipients: '01011112222', text: '안내', messageKind: 'unknown' },
    }, { db })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('parseRecipients — invalid token coverage', () => {
  it('includes non-numeric token in invalid', () => {
    const r = parseRecipients('abc');
    expect(r.invalid).toContain('abc');
  });
});
