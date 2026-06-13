import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
}));

vi.mock('../src/notifyLog.js', () => ({ writeLog: vi.fn() }));

const { handleSyncChatMessages } = await import('../src/chatSyncHandler.js');

function makeFirestore(students, initialState = { exists: false, data: () => ({}) }) {
  const writes = [];
  let syncState = initialState;
  return {
    collection(name) {
      if (name === 'students') {
        return { async get() { return { docs: students.map((s) => ({ data: () => s })) }; } };
      }
      if (name === 'chat_messages') {
        return { doc: (id) => ({ id, path: `chat_messages/${id}` }) };
      }
      return { doc: () => ({}) };
    },
    doc(path) {
      if (path === 'sync_state/chat_messages') {
        return {
          async get() { return syncState; },
          async set(data) { syncState = { exists: true, data: () => data }; },
        };
      }
      return {};
    },
    batch() {
      return { set(ref, data) { writes.push({ id: ref.id, data }); }, async commit() {} };
    },
    writes,
    state: () => syncState,
  };
}

const msg = (n, time, text) => ({ id: `spaces/A/messages/${n}`, space: 'spaces/A', createTime: time, text });

describe('handleSyncChatMessages', () => {
  it('tags only enrolled-student names and writes only matched messages', async () => {
    const firestore = makeFirestore([
      { name: '김민준3', status: '재원' },
      { name: '이몽룡', status: '퇴원' }, // 비재원 → 제외
    ]);
    const fetchMessages = vi.fn().mockResolvedValue([
      msg('1', '2026-06-12T01:00:00Z', '김민준3 숙제 안함'),
      msg('2', '2026-06-12T02:00:00Z', '이몽룡 결석'),     // 퇴원생 → 미적재
      msg('3', '2026-06-12T03:00:00Z', '오늘 날씨 좋다'),   // 무관 → 미적재
    ]);
    const result = await handleSyncChatMessages({ firestore, fetchMessages, chatKey: '{}' });

    expect(fetchMessages).toHaveBeenCalledWith('{}', expect.any(String));
    expect(result.tagged).toBe(1);
    expect(firestore.writes).toHaveLength(1);
    expect(firestore.writes[0].data.student_names).toEqual(['김민준3']);
    expect(firestore.writes[0].data.create_time).toBe('2026-06-12T01:00:00Z');
    expect(firestore.writes[0].id).toBe('spaces_A_messages_1');
  });

  it('does not match a name that is a prefix of a longer numbered name', async () => {
    const firestore = makeFirestore([{ name: '김민준3', status: '재원' }]);
    const fetchMessages = vi.fn().mockResolvedValue([
      msg('1', '2026-06-12T01:00:00Z', '김민준30 상담 완료'), // 김민준3 ⊄ (뒤가 숫자)
    ]);
    const result = await handleSyncChatMessages({ firestore, fetchMessages, chatKey: '{}' });
    expect(result.tagged).toBe(0);
    expect(firestore.writes).toHaveLength(0);
  });

  it('advances last_synced_time to the newest fetched message', async () => {
    const firestore = makeFirestore([{ name: '김민준3', status: '재원' }]);
    const fetchMessages = vi.fn().mockResolvedValue([
      msg('1', '2026-06-12T01:00:00Z', '김민준3'),
      msg('2', '2026-06-12T05:00:00Z', '무관 메시지'),
    ]);
    const result = await handleSyncChatMessages({ firestore, fetchMessages, chatKey: '{}' });
    expect(result.last_synced_time).toBe('2026-06-12T05:00:00Z');
    expect(firestore.state().data().last_synced_time).toBe('2026-06-12T05:00:00Z');
  });

  it('uses stored last_synced_time as the incremental cursor', async () => {
    const firestore = makeFirestore(
      [{ name: '김민준3', status: '재원' }],
      { exists: true, data: () => ({ last_synced_time: '2026-06-10T00:00:00Z' }) },
    );
    const fetchMessages = vi.fn().mockResolvedValue([]);
    await handleSyncChatMessages({ firestore, fetchMessages, chatKey: '{}' });
    expect(fetchMessages).toHaveBeenCalledWith('{}', '2026-06-10T00:00:00Z');
  });

  it('skips when no key', async () => {
    const firestore = makeFirestore([]);
    const result = await handleSyncChatMessages({ firestore, fetchMessages: vi.fn(), chatKey: '' });
    expect(result).toMatchObject({ ok: false, reason: 'no_key' });
  });
});
