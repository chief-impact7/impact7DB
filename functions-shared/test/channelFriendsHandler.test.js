import { describe, it, expect, vi } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));

const { isChannelFriend } = await import('../src/channelFriendsHandler.js');

function makeDb(seed = {}) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        async get() { return { exists: Boolean(seed[name]?.[id]) }; },
      }),
    }),
  };
}

describe('isChannelFriend', () => {
  it('등록 번호는 친구, 아니면 아님', async () => {
    const db = makeDb({ kakao_channel_friends: { '01011112222': {} } });
    expect(await isChannelFriend(db, '010-1111-2222')).toBe(true);
    expect(await isChannelFriend(db, '01000000000')).toBe(false);
    expect(await isChannelFriend(db, '')).toBe(false);
  });
});
