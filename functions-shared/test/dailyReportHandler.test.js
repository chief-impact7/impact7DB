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
  it('친구면 정보형 BMS(kind=report)로 enqueue', async () => {
    const db = makeDb({
      students: { s1: STUDENT },
      kakao_channel_friends: { '01011112222': {} },
    });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: '[6/16] 수업 결과...' } }, { db });
    expect(res).toMatchObject({ queued: true, channel: 'report', joined: true });
    const q = Object.values(db._store.message_queue)[0];
    expect(q).toMatchObject({ kind: 'report', recipient_phone: '01011112222', targeting: 'I', ad_flag: false, content: '[6/16] 수업 결과...' });
  });

  it('비친구면 원본 내용 + 채널 가입 유도 SMS(kind=direct)로 enqueue', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '리포트' } },
      { db, channelAddUrl: 'http://pf.kakao.com/_test' },
    );
    expect(res).toMatchObject({ queued: true, channel: 'invite_sms', joined: false });
    const q = Object.values(db._store.message_queue)[0];
    expect(q.kind).toBe('direct');
    expect(q.content).toContain('리포트'); // 원본 내용 발송
    expect(q.content).toContain('http://pf.kakao.com/_test'); // + 채널 가입 유도
    expect(q.content).not.toContain('{채널링크}');
  });

  it('비친구인데 채널링크가 빈 값이면 유도 생략하고 원본만 발송', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: '리포트' } }, { db, channelAddUrl: '' });
    expect(res).toMatchObject({ channel: 'invite_sms', joined: false });
    expect(Object.values(db._store.message_queue)[0].content).toBe('리포트');
  });

  it('채널링크 기본값(deps/env 없음)으로도 비친구 원본+유도 발송', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const res = await handleSendDailyReport({ auth, data: { studentId: 's1', content: '리포트' } }, { db });
    expect(res).toMatchObject({ channel: 'invite_sms', joined: false });
    const c = Object.values(db._store.message_queue)[0].content;
    expect(c).toContain('리포트'); // 원본
    expect(c).toContain('talk.impact7.kr/kakao'); // + 기본 채널 링크 유도
  });

  it('requestId 중복은 멱등 처리', async () => {
    const db = makeDb({
      students: { s1: STUDENT },
      kakao_channel_friends: { '01011112222': {} },
      message_queue: { 'req-1': { kind: 'report' } },
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

  it('친구+야간+reserveIfNight → 다음 08:00 KST로 예약(scheduled_date)', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: { '01011112222': {} } });
    const nightUtc = new Date('2026-07-02T13:00:00Z'); // KST 22:00 — 야간
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', reserveIfNight: true } },
      { db, now: nightUtc },
    );
    expect(res).toMatchObject({ channel: 'report', joined: true });
    expect(res.scheduledDate).toMatch(/ 08:00:00$/);
    expect(Object.values(db._store.message_queue)[0].scheduled_date).toMatch(/ 08:00:00$/);
  });

  it('친구+주간+reserveIfNight → 예약 없이 즉시(scheduled_date 없음)', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: { '01011112222': {} } });
    const dayUtc = new Date('2026-07-02T03:00:00Z'); // KST 12:00 — 주간
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', reserveIfNight: true } },
      { db, now: dayUtc },
    );
    expect(res.scheduledDate).toBeNull();
    expect(Object.values(db._store.message_queue)[0].scheduled_date).toBeUndefined();
  });

  it('비친구는 reserveIfNight여도 예약 없이 문자 즉시(direct)', async () => {
    const db = makeDb({ students: { s1: STUDENT }, kakao_channel_friends: {} });
    const nightUtc = new Date('2026-07-02T13:00:00Z');
    const res = await handleSendDailyReport(
      { auth, data: { studentId: 's1', content: '안내', reserveIfNight: true } },
      { db, now: nightUtc, channelAddUrl: '' },
    );
    expect(res).toMatchObject({ channel: 'invite_sms', joined: false, scheduledDate: null });
    expect(Object.values(db._store.message_queue)[0].kind).toBe('direct');
  });
});
