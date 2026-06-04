import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runScheduledWithdrawals } from '../src/scheduledWithdrawals.js';

function makeDb(students) {
  const updates = [];
  const sets = [];
  const commits = [];
  const docs = students.map(([id, data]) => ({
    id,
    data: () => data,
    ref: { path: `students/${id}` },
  }));
  const batch = {
    update(ref, data) { updates.push({ ref, data }); },
    set(ref, data) { sets.push({ ref, data }); },
    async commit() { commits.push({ updates: updates.length, sets: sets.length }); },
  };
  return {
    updates,
    sets,
    commits,
    collection(name) {
      if (name === 'students') {
        return {
          where() {
            return {
              async get() {
                return {
                  size: docs.length,
                  forEach(fn) { docs.forEach(fn); },
                };
              },
            };
          },
        };
      }
      return {
        doc() { return { path: `${name}/new` }; },
      };
    },
    batch() { return batch; },
  };
}

describe('runScheduledWithdrawals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T03:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('퇴원일이 도래한 예약 퇴원을 status=퇴원 + enrollments=[]로 발효한다', async () => {
    const db = makeDb([
      ['s1', {
        name: '최윤주',
        status: '재원',
        withdrawal_date: '2026-06-01',
        pre_withdrawal_status: '재원',
        enrollments: [{ class_number: '102' }],
      }],
      ['s2', {
        name: '미래',
        status: '재원',
        withdrawal_date: '2026-06-10',
        pre_withdrawal_status: '재원',
        enrollments: [{ class_number: '103' }],
      }],
    ]);

    const result = await runScheduledWithdrawals(db, '2026-06-04');

    expect(result).toEqual({ checked: 2, processed: 1, today: '2026-06-04' });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].data.status).toBe('퇴원');
    expect(db.updates[0].data.enrollments).toEqual([]);
    expect(db.updates[0].data.pre_withdrawal_status).toBeDefined();
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0].data.change_type).toBe('WITHDRAW');
  });
});
