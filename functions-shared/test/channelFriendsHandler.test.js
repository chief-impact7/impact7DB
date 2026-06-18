import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertAuthorizedStaff: vi.fn() }));

const { handleSyncChannelFriends, handleGetChannelFriends, isChannelFriend } =
  await import('../src/channelFriendsHandler.js');

function makeDb(seed = {}) {
  const store = {};
  for (const [coll, ids] of Object.entries(seed)) store[coll] = { ...ids };
  const col = (name) => {
    if (!store[name]) store[name] = {};
    return {
      doc: (id) => ({
        id,
        async get() { return { exists: id in store[name], id, data: () => store[name][id] }; },
        async set(v) { store[name][id] = v; },
        async delete() { delete store[name][id]; },
      }),
      async get() { return { docs: Object.entries(store[name]).map(([id, data]) => ({ id, data: () => data })) }; },
    };
  };
  return {
    _store: store,
    collection: col,
    batch: () => {
      const ops = [];
      return {
        set: (ref, v) => ops.push(() => ref.set(v)),
        delete: (ref) => ops.push(() => ref.delete()),
        async commit() { for (const op of ops) await op(); },
      };
    },
  };
}

const auth = { token: { email: 'staff@impact7.kr' } };

describe('handleSyncChannelFriends', () => {
  it('정규화·유효성 필터 후 set 교체(추가/제거)', async () => {
    const db = makeDb({ kakao_channel_friends: { '01011112222': {}, '01099998888': {} } });
    const res = await handleSyncChannelFriends(
      { auth, data: { phones: ['010-1111-2222', '010-3333-4444', '123', 'abc'] } },
      { db },
    );
    expect(res).toEqual({ added: 1, removed: 1, total: 2 });
    const ids = Object.keys(db._store.kakao_channel_friends).sort();
    expect(ids).toEqual(['01011112222', '01033334444']); // 9999는 제거, 3344 추가, 짧은/문자 무시
  });

  it('문자열(줄바꿈·쉼표) 입력도 파싱', async () => {
    const db = makeDb();
    const res = await handleSyncChannelFriends({ auth, data: { phones: '01011112222\n010-3333-4444, 01011112222' } }, { db });
    expect(res.total).toBe(2); // 중복 제거
  });

  it('빈 입력 + 기존 존재 → confirmClear 없으면 거부, 있으면 전체 삭제', async () => {
    const db = makeDb({ kakao_channel_friends: { '01011112222': {} } });
    await expect(handleSyncChannelFriends({ auth, data: { phones: [] } }, { db }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    const res = await handleSyncChannelFriends({ auth, data: { phones: [], confirmClear: true } }, { db });
    expect(res).toMatchObject({ removed: 1, total: 0 });
    expect(Object.keys(db._store.kakao_channel_friends)).toHaveLength(0);
  });
});

describe('isChannelFriend / handleGetChannelFriends', () => {
  it('등록 번호는 친구, 아니면 아님', async () => {
    const db = makeDb({ kakao_channel_friends: { '01011112222': {} } });
    expect(await isChannelFriend(db, '010-1111-2222')).toBe(true);
    expect(await isChannelFriend(db, '01000000000')).toBe(false);
    expect(await isChannelFriend(db, '')).toBe(false);
  });

  it('친구 전화번호 전체 조회', async () => {
    const db = makeDb({ kakao_channel_friends: { '01011112222': {}, '01033334444': {} } });
    const res = await handleGetChannelFriends({ auth }, { db });
    expect(res.phones.sort()).toEqual(['01011112222', '01033334444']);
  });
});
