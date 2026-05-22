import { describe, it, expect, vi, beforeEach } from 'vitest';

const setMock = vi.fn();
const getMock = vi.fn();
const docMock = vi.fn(() => ({ id: 'ref' }));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({ doc: docMock }),
    runTransaction: (fn) => fn({ get: getMock, set: setMock }),
  }),
}));

describe('claimIdempotencyKey', () => {
  beforeEach(() => {
    setMock.mockClear();
    getMock.mockClear();
  });

  it('claims a new key → returns true and sets status pending', async () => {
    getMock.mockResolvedValue({ exists: false });
    const { claimIdempotencyKey } = await import('../src/idempotency.js');
    const result = await claimIdempotencyKey('order-123');
    expect(result).toBe(true);
    expect(setMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('rejects an existing key → returns false and does not set', async () => {
    getMock.mockResolvedValue({ exists: true });
    const { claimIdempotencyKey } = await import('../src/idempotency.js');
    const result = await claimIdempotencyKey('order-123');
    expect(result).toBe(false);
    expect(setMock).not.toHaveBeenCalled();
  });
});
