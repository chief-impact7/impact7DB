import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>', delete: () => '<delete>' },
}));

const { handleRetryMessageDelivery, handleManageMessageFailure } = await import('../src/messageRetryHandler.js');

const auth = { uid: 'u1', token: { email: 'director@impact7.kr' } };

// HR_users 역할 조회(assertDirector) + message_queue 트랜잭션을 모두 흉내내는 mock.
function makeFirestore({ queueDoc, role = 'owner' } = {}) {
  const updates = [];
  const deletes = [];
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
      delete(ref) { deletes.push(ref); },
    }),
    _updates: updates,
    _deletes: deletes,
  };
  return firestore;
}

// 재발송 가능해야 하는 기본 실패 doc — purge 전이므로 평문 번호 보유.
const failedDoc = (over = {}) => ({ status: 'failed_retryable', recipient_phone: '01011112222', ...over });

describe('handleRetryMessageDelivery', () => {
  it('requires auth', async () => {
    await expect(handleRetryMessageDelivery({ data: { queueId: 'q1' } }, { firestore: makeFirestore({}) }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    await expect(handleRetryMessageDelivery(
      { auth: { uid: 'u', token: { email: 'x@example.com' } }, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: failedDoc() }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a non-director staff account', async () => {
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: failedDoc(), role: 'staff' }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('requires queueId', async () => {
    await expect(handleRetryMessageDelivery({ auth, data: {} }, { firestore: makeFirestore({ role: 'owner' }) }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('retries a failed_retryable doc — resets attempt_count, bumps manual count, records audit', async () => {
    const firestore = makeFirestore({ queueDoc: failedDoc({ attempt_count: 2, manual_retry_count: 1 }) });
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

  it('allows retry of a failed_permanent doc (원인이 추후 해소되는 실패 — 템플릿 승인 등)', async () => {
    const firestore = makeFirestore({ queueDoc: failedDoc({ status: 'failed_permanent', attempt_count: 3 }) });
    const res = await handleRetryMessageDelivery({ auth, data: { queueId: 'q1' } }, { firestore });
    expect(res).toMatchObject({ ok: true });
    expect(firestore._updates[0]).toMatchObject({ status: 'failed_retryable', attempt_count: 0 });
  });

  it('blocks retry of a PII-purged doc (평문 번호가 삭제돼 재발송 불가)', async () => {
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: { status: 'failed_permanent', recipient_masked: '010****2222', pii_purged_at: { toMillis: () => 1 } } }) },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('blocks retry of promo kinds (수동 재발송은 동의 게이트를 다시 타지 않음)', async () => {
    for (const kind of ['promo', 'promo_sms']) {
      await expect(handleRetryMessageDelivery(
        { auth, data: { queueId: 'q1' } },
        { firestore: makeFirestore({ queueDoc: failedDoc({ kind }) }) },
      )).rejects.toMatchObject({ code: 'failed-precondition' });
    }
  });

  it('rejects when manual retry cap is reached', async () => {
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: failedDoc({ manual_retry_count: 3 }) }) },
    )).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('rejects a retry within the cooldown window', async () => {
    const now = new Date('2026-06-12T10:00:30Z');
    const recent = { toMillis: () => new Date('2026-06-12T10:00:00Z').getTime() }; // 30초 전
    await expect(handleRetryMessageDelivery(
      { auth, data: { queueId: 'q1' } },
      { firestore: makeFirestore({ queueDoc: failedDoc({ retried_at: recent }) }), now },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('allows retry after the cooldown window', async () => {
    const now = new Date('2026-06-12T10:02:00Z');
    const old = { toMillis: () => new Date('2026-06-12T10:00:00Z').getTime() }; // 2분 전
    const firestore = makeFirestore({ queueDoc: failedDoc({ retried_at: old }) });
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

describe('handleManageMessageFailure', () => {
  const staffAuth = { uid: 'u2', token: { email: 'teacher@impact7.kr' } };

  it('requires auth', async () => {
    await expect(handleManageMessageFailure({ data: { queueId: 'q1', action: 'archive' } }, { firestore: makeFirestore({}) }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects an unknown action', async () => {
    await expect(handleManageMessageFailure({ auth: staffAuth, data: { queueId: 'q1', action: 'purge' } }, { firestore: makeFirestore({}) }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('archive: staff can archive a failed doc — status becomes archived with audit fields', async () => {
    const firestore = makeFirestore({ queueDoc: failedDoc({ status: 'failed_permanent' }) });
    const res = await handleManageMessageFailure({ auth: staffAuth, data: { queueId: 'q1', action: 'archive' } }, { firestore });
    expect(res).toMatchObject({ ok: true, action: 'archive' });
    expect(firestore._updates[0]).toMatchObject({
      status: 'archived',
      archived_from: 'failed_permanent',
      archived_by: 'teacher@impact7.kr',
    });
  });

  it('archive: rejects a doc that is already archived', async () => {
    await expect(handleManageMessageFailure(
      { auth: staffAuth, data: { queueId: 'q1', action: 'archive' } },
      { firestore: makeFirestore({ queueDoc: { status: 'archived' } }) },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('archive/delete: rejects failed_retryable (로그 미기록·purge_after 미설정 — 이력 소실/PII 잔존 방지)', async () => {
    for (const action of ['archive', 'delete']) {
      await expect(handleManageMessageFailure(
        { auth, data: { queueId: 'q1', action } },
        { firestore: makeFirestore({ queueDoc: failedDoc() }) },
      )).rejects.toMatchObject({ code: 'failed-precondition' });
    }
  });

  it('archive: rejects an in-flight doc (워커와 경합 방지)', async () => {
    await expect(handleManageMessageFailure(
      { auth: staffAuth, data: { queueId: 'q1', action: 'archive' } },
      { firestore: makeFirestore({ queueDoc: { status: 'pending' } }) },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('delete: requires director — staff is denied', async () => {
    await expect(handleManageMessageFailure(
      { auth: staffAuth, data: { queueId: 'q1', action: 'delete' } },
      { firestore: makeFirestore({ queueDoc: failedDoc(), role: 'staff' }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('delete: director can delete a failed or archived doc', async () => {
    const firestore = makeFirestore({ queueDoc: { status: 'archived' } });
    const res = await handleManageMessageFailure({ auth, data: { queueId: 'q1', action: 'delete' } }, { firestore });
    expect(res).toMatchObject({ ok: true, action: 'delete' });
    expect(firestore._deletes).toHaveLength(1);
    expect(firestore._updates).toHaveLength(0);
  });

  it('delete: rejects a sent doc', async () => {
    await expect(handleManageMessageFailure(
      { auth, data: { queueId: 'q1', action: 'delete' } },
      { firestore: makeFirestore({ queueDoc: { status: 'sent' } }) },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
