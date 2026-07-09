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
  return { _store: store, collection: col };
}

const auth = { token: { email: 'staff@impact7.kr' } };
const STUDENT = { name: '김동윤', parent_phone_1: '010-1111-2222' };

describe('handleSendDailyReport', () => {
  it('친구 여부와 무관하게 LMS/SMS(kind=direct)로 enqueue', async () => {
    const db = makeDb({
      students: { s1: STUDENT },
      kakao_channel_friends: { '01011112222': {} },
    });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: '[6/16] 수업 결과...' } }, { db });
    expect(res).toMatchObject({ queued: true, channel: 'sms', joined: false });
    const q = Object.values(db._store.message_queue)[0];
    expect(q).toMatchObject({ kind: 'direct', recipient_phone: '01011112222', recipient_role: 'parent_1', content: '[6/16] 수업 결과...' });
    expect(q.targeting).toBeUndefined();
  });

  it('recipientFields 다중 선택 시 수신자별 문자 큐를 enqueue한다', async () => {
    const db = makeDb({
      students: { s1: { name: '김동윤', parent_phone_1: '010-1111-2222', parent_phone_2: '010-3333-4444' } },
      kakao_channel_friends: { '01011112222': {} },
    });
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', recipientFields: ['parent_1', 'parent_2'], requestId: 'rpt1' } },
      { db, channelAddUrl: '' },
    );
    expect(res).toMatchObject({ queued: true, queuedCount: 2, channel: 'sms', joinedCount: 0 });
    const qs = Object.values(db._store.message_queue);
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => [q.recipient_role, q.kind, q.recipient_phone])).toEqual([
      ['parent_1', 'direct', '01011112222'],
      ['parent_2', 'direct', '01033334444'],
    ]);
  });

  it('비친구도 원본 내용만 LMS/SMS(kind=direct)로 enqueue', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '리포트' } },
      { db, channelAddUrl: 'http://pf.kakao.com/_test' },
    );
    expect(res).toMatchObject({ queued: true, channel: 'sms', joined: false });
    const q = Object.values(db._store.message_queue)[0];
    expect(q.kind).toBe('direct');
    expect(q.content).toBe('리포트');
  });

  it('비친구인데 채널링크가 빈 값이면 유도 생략하고 원본만 발송', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: '리포트' } }, { db, channelAddUrl: '' });
    expect(res).toMatchObject({ channel: 'sms', joined: false });
    expect(Object.values(db._store.message_queue)[0].content).toBe('리포트');
  });

  it('채널링크 기본값(deps/env 없음)이어도 원본만 발송', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: '리포트' } }, { db });
    expect(res).toMatchObject({ channel: 'sms', joined: false });
    const c = Object.values(db._store.message_queue)[0].content;
    expect(c).toBe('리포트');
  });

  it('requestId 중복은 멱등 처리', async () => {
    const db = makeDb({
      students: { s1: STUDENT },
      kakao_channel_friends: { '01011112222': {} },
      message_queue: { 'req-1': { kind: 'direct' } },
    });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: 'x', requestId: 'req-1' } }, { db });
    expect(res).toMatchObject({ duplicate: true });
  });

  it('학생 없음/본문 없음 거부', async () => {
    const db = makeDb({ students: {} });
    await expect(handleSendDailyReport({ auth, data: { studentId: 'x', content: 'a' } }, { db }))
      .rejects.toMatchObject({ code: 'not-found' });
    await expect(handleSendDailyReport({ auth, data: { studentId: 's1', content: '' } }, { db }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('reserveIfNight가 있어도 문자로 즉시 큐잉한다', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: { '01011112222': {} } });
    const nightUtc = new Date('2026-07-02T13:00:00Z'); // KST 22:00 — 야간
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', reserveIfNight: true } },
      { db, now: nightUtc },
    );
    expect(res).toMatchObject({ channel: 'sms', joined: false, scheduledDate: null });
    expect(Object.values(db._store.message_queue)[0].scheduled_date).toBeNull();
  });

  it('친구+주간+reserveIfNight → 예약 없이 즉시 문자', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: { '01011112222': {} } });
    const dayUtc = new Date('2026-07-02T03:00:00Z'); // KST 12:00 — 주간
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', reserveIfNight: true } },
      { db, now: dayUtc },
    );
    expect(res.scheduledDate).toBeNull();
    expect(Object.values(db._store.message_queue)[0].scheduled_date).toBeNull();
  });

  it('비친구는 reserveIfNight여도 예약 없이 문자 즉시(direct)', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const nightUtc = new Date('2026-07-02T13:00:00Z');
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', reserveIfNight: true } },
      { db, now: nightUtc, channelAddUrl: '' },
    );
    expect(res).toMatchObject({ channel: 'sms', joined: false, scheduledDate: null });
    expect(Object.values(db._store.message_queue)[0].kind).toBe('direct');
  });
});
