import { describe, it, expect, vi } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const { handleSendDailyReport } = await import('../src/dailyReportHandler.js');

function makeDb(seed = {}) {
  const store = {};
  for (const [coll, ids] of Object.entries(seed)) store[coll] = { ...ids };
  let counter = 0;
  const col = (name) => {
    if (!store[name]) store[name] = {};
    return {
      doc: (id) => {
        const rid = id ?? `auto_${counter++}`;
        return {
          id: rid,
          async get() { return { exists: rid in store[name], id: rid, data: () => store[name][rid] }; },
          async set(v) { store[name][rid] = v; },
          async create(v) {
            if (rid in store[name]) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
            store[name][rid] = v;
          },
        };
      },
    };
  };
  return {
    _store: store,
    collection: col,
    batch() {
      const ops = [];
      return {
        create(ref, value) { ops.push(() => ref.create(value)); },
        set(ref, value) { ops.push(() => ref.set(value)); },
        async commit() {
          const snapshot = structuredClone(store);
          try {
            for (const op of ops) await op();
          } catch (error) {
            for (const key of Object.keys(store)) delete store[key];
            Object.assign(store, snapshot);
            throw error;
          }
        },
      };
    },
  };
}

const auth = { token: { email: 'staff@impact7.kr' } };
const STUDENT = { name: '김동윤', parent_phone_1: '010-1111-2222' };

describe('handleSendDailyReport', () => {
  it('LMS/SMS(kind=direct)로 enqueue', async () => {
    const db = makeDb({ students: { s1: STUDENT } });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: '[6/16] 수업 결과...', reportDate: '2026-06-16' } }, { db });
    expect(res).toMatchObject({ queued: true, channel: 'sms' });
    const q = Object.values(db._store.message_queue)[0];
    expect(q).toMatchObject({ kind: 'direct', source: 'parent_report', report_date_kst: '2026-06-16', recipient_phone: '01011112222', recipient_role: 'parent_1', content: '[6/16] 수업 결과...' });
    expect(q.targeting).toBeUndefined();
  });

  it('recipientFields 다중 선택 시 수신자별 문자 큐를 enqueue한다', async () => {
    const db = makeDb({
      students: { s1: { name: '김동윤', parent_phone_1: '010-1111-2222', parent_phone_2: '010-3333-4444' } },
    });
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', recipientFields: ['parent_1', 'parent_2'], requestId: 'rpt1' } },
      { db },
    );
    expect(res).toMatchObject({ queued: true, queuedCount: 2, channel: 'sms' });
    const qs = Object.values(db._store.message_queue);
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => [q.recipient_role, q.kind, q.recipient_phone])).toEqual([
      ['parent_1', 'direct', '01011112222'],
      ['parent_2', 'direct', '01033334444'],
    ]);
  });

  it('길이 초과 리포트는 거부하고 명시적 선택 시 분할한다', async () => {
    const content = '가'.repeat(1001);
    const rejectedDb = makeDb({ students: { s1: STUDENT } });
    await expect(handleSendDailyReport(
      { auth, data: { studentId: 's1', content } },
      { db: rejectedDb },
    )).rejects.toMatchObject({ details: expect.objectContaining({ splitParts: 2 }) });
    expect(Object.values(rejectedDb._store.message_queue || {})).toHaveLength(0);

    const splitDb = makeDb({ students: { s1: STUDENT } });
    const result = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content, requestId: 'same-id', splitLongMessage: true } },
      { db: splitDb },
    );
    expect(result).toMatchObject({ queuedCount: 2, splitParts: 2 });
    const docs = Object.values(splitDb._store.message_queue);
    expect(docs.every((doc) => doc.split_group_id === 'daily:same-id:s1:parent_1')).toBe(true);
    expect(Object.keys(splitDb._store.message_queue).every((id) => id.startsWith('daily_same-id_'))).toBe(true);
    expect(docs
      .sort((a, b) => a.split_part_index - b.split_part_index)
      .map((doc) => doc.content.slice(0, 5)))
      .toEqual(['[1/2]', '[2/2]']);
  });

  it('requestId 중복은 멱등 처리', async () => {
    const db = makeDb({ students: { s1: STUDENT } });
    const data = { studentId: 's1', content: 'x', requestId: 'req-1' };
    await handleSendDailyReport({ auth, data }, { db });
    const res = await handleSendDailyReport({ auth, data }, { db });
    expect(res).toMatchObject({ duplicate: true });
    expect(db._store.message_request_batches['daily_req-1'].request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(db._store.message_queue['daily_req-1'].request_fingerprint).not.toContain('x');
  });

  it('구버전 requestId 큐가 있으면 배포 후 재시도도 중복으로 처리한다', async () => {
    const db = makeDb({
      students: { s1: STUDENT },
      message_queue: { 'legacy-report': { kind: 'direct', source: 'parent_report' } },
    });
    const res = await handleSendDailyReport({
      auth,
      data: { studentId: 's1', content: '안내', requestId: 'legacy-report' },
    }, { db });

    expect(res).toMatchObject({ duplicate: true, queuedCount: 0 });
    expect(Object.keys(db._store.message_queue)).toEqual(['legacy-report']);
  });

  it('구버전 다중 수신 큐가 일부만 있으면 누락 수신자만 생성한다', async () => {
    const db = makeDb({
      students: {
        s1: { ...STUDENT, parent_phone_2: '010-3333-4444' },
      },
      message_queue: {
        'legacy-partial_parent_1': { kind: 'direct', recipient_role: 'parent_1' },
      },
    });
    const res = await handleSendDailyReport({
      auth,
      data: {
        studentId: 's1',
        content: '안내',
        recipientFields: ['parent_1', 'parent_2'],
        requestId: 'legacy-partial',
      },
    }, { db });

    expect(res).toMatchObject({ queued: true, queuedCount: 1, duplicateCount: 1 });
    expect(Object.values(db._store.message_queue).map((doc) => doc.recipient_role).sort())
      .toEqual(['parent_1', 'parent_2']);
    expect(db._store.message_request_batches['daily_legacy-partial']).toBeDefined();
  });

  it('같은 requestId로 내용이 바뀐 재시도는 거부한다', async () => {
    const db = makeDb({ students: { s1: STUDENT } });
    await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '원문', requestId: 'req-1' } },
      { db },
    );
    await expect(handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '수정문', requestId: 'req-1' } },
      { db },
    )).rejects.toThrow('이전 요청과 다릅니다');
  });

  it('같은 requestId로 분할 선택이나 수신 대상이 바뀐 재시도는 거부한다', async () => {
    const db = makeDb({
      students: {
        s1: {
          ...STUDENT,
          parent_phone_2: '010-3333-4444',
        },
      },
    });
    const data = { studentId: 's1', content: '안내', requestId: 'req-shape' };
    await handleSendDailyReport({ auth, data }, { db });

    await expect(handleSendDailyReport(
      { auth, data: { ...data, splitLongMessage: true } },
      { db },
    )).rejects.toThrow('이전 요청과 다릅니다');
    await expect(handleSendDailyReport(
      { auth, data: { ...data, recipientFields: ['parent_1', 'parent_2'] } },
      { db },
    )).rejects.toThrow('이전 요청과 다릅니다');
    expect(Object.keys(db._store.message_queue)).toHaveLength(1);
  });

  it('학생 없음/본문 없음 거부', async () => {
    const db = makeDb({ students: {} });
    await expect(handleSendDailyReport({ auth, data: { studentId: 'x', content: 'a' } }, { db }))
      .rejects.toMatchObject({ code: 'not-found' });
    await expect(handleSendDailyReport({ auth, data: { studentId: 's1', content: '' } }, { db }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('reserveIfNight가 있어도 문자로 즉시 큐잉한다', async () => {
    const db = makeDb({ students: { s1: STUDENT } });
    const nightUtc = new Date('2026-07-02T13:00:00Z'); // KST 22:00 — 야간
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', reserveIfNight: true } },
      { db, now: nightUtc },
    );
    expect(res).toMatchObject({ channel: 'sms', scheduledDate: null });
    expect(Object.values(db._store.message_queue)[0].scheduled_date).toBeNull();
  });

});
