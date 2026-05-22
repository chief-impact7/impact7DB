import { describe, it, expect, vi } from 'vitest';

const addMock = vi.fn().mockResolvedValue({ id: 'x' });
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ add: addMock }) }),
  FieldValue: { serverTimestamp: () => 'TS' },
}));

describe('writeLog', () => {
  it('writes entry with timestamp', async () => {
    const { writeLog } = await import('../src/notifyLog.js');
    await writeLog({ channel: 'llm', uid: 'u1' });
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'llm', uid: 'u1', created_at: 'TS' }),
    );
  });
});
