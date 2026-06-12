import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
}));

const { handleRetryMessageDelivery } = await import('../src/messageRetryHandler.js');

const auth = { uid: 'u1', token: { email: 'director@impact7.kr' } };

// HR_users 역할 조회(assertDirector) + message_queue 트랜잭션을 모두 흉내내는 mock.
function makeFirestore({ queueDoc, role = 'owner' } = {}) {
  const updates = [];
  const queueRef = { id: 'q1', _updates: updates };
  const firestore = {
    collection(name) {
      if (name === 'HR_users') {
        return { doc: () => ({ get: async () => (role ? { exists: true, data: () => ({ role }) } : { exists: false }) }) };
      }
      return { doc: () => queueRef }; // message_queue
    },
    runTransaction: (fn) => fn({
      async get() {
        return queueDoc ? { exists: true, data: () => queueDoc } : { exists: false };
      },
      update(_ref, data) { updates.push(data); },
    }),
    _updates: updates,
  };
  return firestore;
}

describe('handleRetryMessageDelivery', () => {
  it('requires auth', async () => {
    await expect(handleRetryMessageDelivery({ data: { queueId: 'q1' } }, { firestore: makeFirestore({}) }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    await expect(handleRetryMessageDelivery(
      { auth: { uid: 'u', token: { email: 'x@example.com' } }, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: { status: 'failed_retryable' } }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a non-director staff account', async () => {
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: { status: 'failed_retryable' }, role: 'staff' }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('requires queueId', async () => {
    await expect(handleRetryMessageDelivery({ auth, data: {} }, { firestore: makeFirestore({ role: 'owner' }) }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('retries a failed_retryable doc — resets attempt_count, bumps manual count, records audit', async () => {
    const firestore = makeFirestore({ queueDoc: { status: 'failed_retryable', attempt_count: 2, manual_retry_count: 1 } });
    const res = await handleRetryMessageDelivery({ auth, data: { queueId: 'q1' } }, { firestore });
    expect(res).toMatchObject({ ok: true, queueId: 'q1' });
    expect(firestore._updates).toHaveLength(1);
    expect(firestore._updates[0]).toMatchObject({
      status: 'failed_retryable',
      attempt_count: 0,
      last_error_code: null,
      manual_retry_count: 2,
      retried_by: 'director@impact7.kr',
    });
    expect(firestore._updates[0].retried_at).toBe('<serverTimestamp>');
  });

  it('blocks retry of a failed_permanent doc (bad number / template rejection)', async () => {
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: { status: 'failed_permanent', attempt_count: 3 } }) },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects when manual retry cap is reached', async () => {
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: { status: 'failed_retryable', manual_retry_count: 3 } }) },
    )).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('rejects a retry within the cooldown window', async () => {
    const now = new Date('2026-06-12T10:00:30Z');
    const recent = { toMillis: () => new Date('2026-06-12T10:00:00Z').getTime() }; // 30초 전
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: { status: 'failed_retryable', retried_at: recent } }), now },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('allows retry after the cooldown window', async () => {
    const now = new Date('2026-06-12T10:02:00Z');
    const old = { toMillis: () => new Date('2026-06-12T10:00:00Z').getTime() }; // 2분 전
    const firestore = makeFirestore({ queueDoc: { status: 'failed_retryable', retried_at: old } });
    const res = await handleRetryMessageDelivery({ auth, data: { queueId: 'q1' } }, { firestore, now });
    expect(res).toMatchObject({ ok: true });
  });

  it('rejects retry on a non-failed status', async () => {
    await expect(handleRetryMessageDelivery({ auth, data: { queueId: 'q1' } }, { firestore: makeFirestore({ queueDoc: { status: 'sent' } }) }))
      .rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('throws not-found for a missing doc', async () => {
    await expect(handleRetryMessageDelivery({ auth, data: { queueId: 'q1' } }, { firestore: makeFirestore({ queueDoc: null }) }))
      .rejects.toMatchObject({ code: 'not-found' });
  });
});
