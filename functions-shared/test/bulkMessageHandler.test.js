import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const { buildBulkRecipients, handleCreateBulkMessage } = await import('../src/bulkMessageHandler.js');

const auth = { token: { email: 'staff@impact7.kr' }, uid: 'u1' };

describe('buildBulkRecipients (정보성: 전원, 동의 무관)', () => {
  it('queues everyone with a phone, disable_sms=false, targeting=I', () => {
    const entries = [
      { id: 's1', student: { parent_phone_1: '01011112222' } },
      { id: 's2', student: { parent_phone_1: '', parent_phone_2: '01033334444' } },
      { id: 's3', student: {} }, // 번호 없음 → 제외
      // 광고 옵트아웃이어도 정보성은 발송
      { id: 's4', student: { parent_phone_1: '01055556666', message_consent: { promo: { optedIn: true, revokedAt: new Date() } } } },
    ];
    const { docs, stats } = buildBulkRecipients(entries, { campaignId: 'c1', content: '안내', recipientField: undefined, scheduledDate: null });
    expect(stats).toMatchObject({ total: 4, queued: 3, skipped_no_phone: 1 });
    expect(docs.every((d) => d.disable_sms === false && d.targeting === 'I' && d.ad_flag === false && d.kind === 'promo')).toBe(true);
    expect(docs.map((d) => d.recipient_phone)).toEqual(['01011112222', '01033334444', '01055556666']);
  });
});

function makeDb() {
  const docs = {};
  let n = 0;
  const col = (name) => ({
    doc: (id) => { const key = id ?? `${name}_auto_${n++}`; return {
      id: id ?? key,
      async get() { return { exists: !!docs[`${name}/${key}`], data: () => docs[`${name}/${key}`] }; },
      async set(v) { docs[`${name}/${key}`] = v; },
      async update(v) { docs[`${name}/${key}`] = { ...docs[`${name}/${key}`], ...v }; },
    }; },
  });
  return {
    _docs: docs,
    collection: col,
    async getAll(...refs) { return refs.map((r) => ({ id: r.id, exists: !!docs[`students/${r.id}`], data: () => docs[`students/${r.id}`] })); },
    batch() { const ops = []; return { set: (ref, v) => ops.push([ref, v]), create: (ref, v) => ops.push([ref, v, true]), async commit() { for (const [ref, v] of ops) await ref.set(v); } }; },
  };
}

describe('handleCreateBulkMessage', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
    db._docs['students/s1'] = { parent_phone_1: '01011112222' };
    db._docs['students/s2'] = { parent_phone_1: '01033334444' };
  });

  it('enqueues promo(kind) docs with targeting=I for all valid students', async () => {
    const res = await handleCreateBulkMessage({ auth, data: { title: '개강', content: '여름학기 개강 안내', studentIds: ['s1', 's2'] } }, { db });
    expect(res.stats).toMatchObject({ total: 2, queued: 2 });
    const queue = Object.entries(db._docs).filter(([k]) => k.startsWith('message_queue/')).map(([, v]) => v);
    expect(queue).toHaveLength(2);
    expect(queue.every((d) => d.kind === 'promo' && d.targeting === 'I' && d.disable_sms === false)).toBe(true);
  });

  it('rejects empty content / empty studentIds', async () => {
    await expect(handleCreateBulkMessage({ auth, data: { title: 't', content: ' ', studentIds: ['s1'] } }, { db })).rejects.toThrow();
    await expect(handleCreateBulkMessage({ auth, data: { title: 't', content: 'x', studentIds: [] } }, { db })).rejects.toThrow();
  });

  it('is idempotent on requestId', async () => {
    const data = { title: 't', content: 'x', studentIds: ['s1'], requestId: 'b-1' };
    await handleCreateBulkMessage({ auth, data }, { db });
    const second = await handleCreateBulkMessage({ auth, data }, { db });
    expect(second.duplicate).toBe(true);
    const queue = Object.keys(db._docs).filter((k) => k.startsWith('message_queue/'));
    expect(queue).toHaveLength(1);
  });
});
