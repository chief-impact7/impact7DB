import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

const { handleStaffAutoClockout } = await import('../src/staffAutoClockoutHandler.js');

const PREV_DATE = '2026-07-01';
const CLOCKOUT_ISO = new Date(`${PREV_DATE}T22:30:00+09:00`).toISOString(); // 2026-07-01T13:30:00.000Z
const CLOCKOUT_MS = new Date(CLOCKOUT_ISO).getTime();

function makeFirestore(docs = []) {
  const updates = [];
  let committed = false;

  const q = {
    where() { return q; },
    async get() {
      return {
        docs: docs.map((d, i) => ({
          id: d._id || `doc${i}`,
          ref: { id: d._id || `doc${i}` },
          data: () => d,
        })),
      };
    },
  };

  const batch = {
    update(ref, data) { updates.push({ id: ref.id, data }); },
    async commit() { committed = true; },
  };

  return {
    collection: () => q,
    batch: () => batch,
    _updates: updates,
    _committed: () => committed,
  };
}

describe('handleStaffAutoClockout — 근무중 직원 자동 퇴근', () => {
  it('근무중 직원을 전날 22:30 KST 퇴근으로 기록한다', async () => {
    const fs = makeFirestore([
      { _id: 'att1', state: '근무중', events: [{ action: '출근', at: `${PREV_DATE}T01:00:00.000Z`, at_ms: 1 }] },
    ]);

    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });

    expect(res).toEqual({ date: PREV_DATE, processed: 1 });
    expect(fs._updates).toHaveLength(1);
    const { data } = fs._updates[0];
    expect(data.state).toBe('퇴근');
    expect(data.departAt).toBe(CLOCKOUT_ISO);
    expect(data.last_event).toEqual({ action: '퇴근', at_ms: CLOCKOUT_MS });
    expect(data.updated_by).toBe('system-auto');
    expect(data.events).toHaveLength(2);
    expect(data.events[1]).toEqual({ action: '퇴근', at: CLOCKOUT_ISO, at_ms: CLOCKOUT_MS });
    expect(fs._committed()).toBe(true);
  });

  it('기존 events 가 없어도 events 배열을 새로 만든다', async () => {
    const fs = makeFirestore([
      { _id: 'att2', state: '근무중' },
    ]);

    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });

    expect(res.processed).toBe(1);
    expect(fs._updates[0].data.events).toHaveLength(1);
    expect(fs._updates[0].data.events[0].action).toBe('퇴근');
  });
});

describe('handleStaffAutoClockout — 멱등', () => {
  it('이미 퇴근한 직원은 건너뛴다', async () => {
    const fs = makeFirestore([
      { _id: 'att3', state: '퇴근', departAt: `${PREV_DATE}T05:00:00.000Z`, events: [] },
    ]);

    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });

    expect(res.processed).toBe(0);
    expect(fs._updates).toHaveLength(0);
    expect(fs._committed()).toBe(false);
  });

  it('조회 결과가 비어 있으면 처리 없이 반환한다', async () => {
    const fs = makeFirestore([]);

    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });

    expect(res).toEqual({ date: PREV_DATE, processed: 0 });
    expect(fs._updates).toHaveLength(0);
    expect(fs._committed()).toBe(false);
  });
});

describe('handleStaffAutoClockout — 22:30 KST 시각 계산', () => {
  it('22:30 KST는 13:30 UTC (UTC+9, DST 없음)', () => {
    expect(CLOCKOUT_ISO).toBe(`${PREV_DATE}T13:30:00.000Z`);
  });
});
