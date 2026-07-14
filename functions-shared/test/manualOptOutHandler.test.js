import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));
vi.mock('../src/authGuards.js', () => ({ assertManagerOrAbove: vi.fn() }));

const { handleGetManualOptOuts, handleRegisterManualOptOut } = await import('../src/manualOptOutHandler.js');
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

    expect(result).toEqual({ recipientMasked: '***-****-5678', requestedDate: '2026-07-14', registered: true });
    expect(JSON.stringify(result)).not.toContain('01012345678');
    const post = calls.find((call) => call.options.method === 'POST');
    expect(JSON.parse(post.options.body)).toMatchObject({ phoneNumber: '01012345678', blockGroupIds: ['bg1'] });
    expect(audit[0]).not.toHaveProperty('recipient_phone');
    expect(audit[0]).toMatchObject({ requested_date: '2026-07-14', memo: '요청', provider_block_group_id: 'bg1' });
  });

  it('loads Solapi pages and reconciles them with DSC audit rows without plaintext', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url.includes('/block/groups/')) {
        return response({ blockGroups: [{ blockGroupId: 'bg1', status: 'ACTIVE', useAll: true }] });
      }
      if (url.includes('startKey=next1')) {
        return response({ nextKey: null, blockNumbers: [{ blockNumberId: 'bn2', phoneNumber: '01099998888', memo: '솔라피 등록', dateCreated: '2026-07-13T00:00:00.000Z' }] });
      }
      return response({ nextKey: 'next1', blockNumbers: [{ blockNumberId: 'bn1', phoneNumber: '01012345678', memo: '요청', dateCreated: '2026-07-14T00:00:00.000Z' }] });
    });
    const localDocs = [{
      id: 'a1',
      data: () => ({ provider_block_number_id: 'bn1', recipient_masked: '***-****-5678', requested_date: '2026-07-12', memo: 'DSC 요청', created_at: { toMillis: () => 1 } }),
    }];
    const db = {
      collection: () => ({
        orderBy: () => ({ limit: () => ({ get: async () => ({ docs: localDocs, size: localDocs.length }) }) }),
      }),
    };

    const result = await handleGetManualOptOuts(
      { auth, data: {} },
      { db, apiKey: 'key', apiSecret: 'secret', fetchFn, now: new Date('2026-07-14T00:00:00.000Z') },
    );

    expect(result).toMatchObject({ matchedCount: 1, solapiOnlyCount: 1, localOnlyCount: 0 });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bn1', recipientMasked: '***-****-5678', requestedDate: '2026-07-12', syncStatus: 'matched' }),
      expect.objectContaining({ id: 'bn2', recipientMasked: '***-****-8888', syncStatus: 'solapi_only' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('01012345678');
    expect(JSON.stringify(result)).not.toContain('01099998888');
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
