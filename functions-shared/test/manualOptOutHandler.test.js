import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertManagerOrAbove: vi.fn() }));

const { handleRegisterManualOptOut } = await import('../src/manualOptOutHandler.js');
const auth = { uid: 'u1', token: { email: 'manager@impact7.kr' } };

function response(data) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
}

describe('handleRegisterManualOptOut', () => {
  it('reuses an active all-sender group and registers the number without returning plaintext', async () => {
    const calls = [];
    const fetchFn = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/block/groups/')) return response({ blockGroups: [{ blockGroupId: 'bg1', status: 'ACTIVE', useAll: true }] });
      if (url.includes('/block/numbers/?')) return response({ blockNumbers: [] });
      return response({ blockNumberId: 'bn1' });
    });
    const audit = [];
    const db = { collection: () => ({ add: async (value) => audit.push(value) }) };

    const result = await handleRegisterManualOptOut(
      { auth, data: { phone: '010-1234-5678', memo: '요청' } },
      { db, apiKey: 'key', apiSecret: 'secret', fetchFn, now: new Date('2026-07-14T00:00:00.000Z') },
    );

    expect(result).toEqual({ recipientMasked: '***-****-5678', registered: true });
    expect(JSON.stringify(result)).not.toContain('01012345678');
    const post = calls.find((call) => call.options.method === 'POST');
    expect(JSON.parse(post.options.body)).toMatchObject({ phoneNumber: '01012345678', blockGroupIds: ['bg1'] });
    expect(audit[0]).not.toHaveProperty('recipient_phone');
  });

  it('rejects a non-mobile number before calling Solapi', async () => {
    const fetchFn = vi.fn();
    await expect(handleRegisterManualOptOut(
      { auth, data: { phone: '02-2649-0509' } },
      { db: {}, apiKey: 'key', apiSecret: 'secret', fetchFn },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('creates an active all-sender group when none exists', async () => {
    const posts = [];
    const fetchFn = vi.fn(async (url, options) => {
      if (url.includes('/block/groups/') && options.method === 'GET') return response({ blockGroups: [] });
      if (url.includes('/block/groups/') && options.method === 'POST') return response({ blockGroupId: 'created-group' });
      if (url.includes('/block/numbers/?')) return response({ blockNumbers: [] });
      posts.push(JSON.parse(options.body));
      return response({ blockNumberId: 'bn1' });
    });
    const db = { collection: () => ({ add: async () => {} }) };

    await handleRegisterManualOptOut(
      { auth, data: { phone: '01012345678' } },
      { db, apiKey: 'key', apiSecret: 'secret', fetchFn },
    );

    expect(posts[0].blockGroupIds).toEqual(['created-group']);
  });
});
