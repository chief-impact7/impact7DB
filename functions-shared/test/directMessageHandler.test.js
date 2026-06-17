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
      return {
        id: resolvedId,
        async get() { return { exists: !!docs[`${name}/${resolvedId}`], data: () => docs[`${name}/${resolvedId}`] }; },
        async set(v) { docs[`${name}/${resolvedId}`] = v; },
      };
    },
    async add(v) { const id = `auto_${counter++}`; docs[`${name}/${id}`] = v; return { id }; },
  });
  return { _docs: docs, collection: col, batch: () => { const ops = []; return { set: (ref, v) => ops.push([ref, v]), async commit() { for (const [ref, v] of ops) await ref.set(v); } }; } };
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
    expect(directDocs[0]).toMatchObject({ kind: 'direct', status: 'pending', content: '안내', recipient_phone: '01011112222' });
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
});
