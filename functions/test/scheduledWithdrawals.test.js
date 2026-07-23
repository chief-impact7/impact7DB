import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runScheduledWithdrawals } from '../src/scheduledWithdrawals.js';

function makeDb(students, requests = []) {
  const updates = [];
  const sets = [];
  const commits = [];
  const studentDocs = students.map(([id, data]) => ({
    id,
    data: () => data,
    ref: { path: `students/${id}` },
  }));
  const requestDocs = requests.map(([id, data]) => ({
    id,
    data: () => data,
    ref: { path: `leave_requests/${id}` },
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
                  size: studentDocs.length,
                  forEach(fn) { studentDocs.forEach(fn); },
                };
              },
            };
          },
        };
      }
      if (name === 'leave_requests') {
        return {
          where() {
            return {
              async get() {
                return {
                  docs: requestDocs,
                  size: requestDocs.length,
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

  it('pre_withdrawal_status 없이도 도래한 재원계열 퇴원을 발효한다', async () => {
    const db = makeDb([
      ['s1', {
        name: '최윤주',
        status: '재원',
        withdrawal_date: '2026-06-01',
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

    expect(result).toEqual({
      checked: 2,
      processed: 1,
      accountChecked: 0,
      accountProcessed: 0,
      accountFailures: [],
      today: '2026-06-04',
    });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].data.status).toBe('퇴원');
    expect(db.updates[0].data.enrollments).toEqual([]);
    expect(db.updates[0].data.pre_withdrawal_status).toBeDefined();
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0].data.change_type).toBe('WITHDRAW');
  });

  it('예약 휴원 발효와 잘못 선반영된 미래 휴원·퇴원 복구를 서버에서 처리한다', async () => {
    const db = makeDb([
      ['leave-due', {
        status: '재원',
        scheduled_leave_status: '실휴원',
        pause_start_date: '2026-06-04',
        enrollments: [{ class_number: '101' }],
      }],
      ['leave-future', {
        status: '가휴원',
        scheduled_leave_status: '가휴원',
        pause_start_date: '2026-06-10',
        enrollments: [{ class_number: '102' }],
      }],
      ['withdraw-future', {
        status: '퇴원',
        withdrawal_date: '2026-06-10',
        pre_withdrawal_status: '등원예정',
        enrollments: [{ class_number: '103' }],
      }],
    ]);

    const result = await runScheduledWithdrawals(db, '2026-06-04');

    expect(result.processed).toBe(3);
    expect(db.updates.map(({ data }) => data.status)).toEqual(['실휴원', '재원', '등원예정']);
    expect(db.updates[0].data.scheduled_leave_status).toBeDefined();
    expect(db.updates[1].data.scheduled_leave_status).toBe('가휴원');
  });

  it('도래한 계정 예약만 같은 finalize 경로로 적용하고 마커 이후 재실행은 건너뛴다', async () => {
    const duePause = {
      status: 'approved',
      request_type: '휴원요청',
      leave_start_date: '2026-06-04',
      account_target: { account_id: 'regular-1' },
    };
    const dueEnd = {
      status: 'approved',
      request_type: '퇴원요청',
      withdrawal_date: '2026-06-01',
      account_target: { account_id: 'special-1' },
    };
    const db = makeDb([], [
      ['pause-due', duePause],
      ['end-due', dueEnd],
      ['pause-applied', {
        ...duePause,
        account_target: { account_id: 'regular-2', start_applied_at: 'done' },
      }],
      ['end-applied', {
        ...dueEnd,
        account_target: { account_id: 'special-2', end_applied_at: 'done' },
      }],
      ['pause-future', {
        ...duePause,
        leave_start_date: '2026-07-01',
        account_target: { account_id: 'regular-3' },
      }],
    ]);
    const finalizeRequest = vi.fn(async (_ref, request) => {
      if (request.request_type === '휴원요청') {
        request.account_target.start_applied_at = 'done';
      } else {
        request.account_target.end_applied_at = 'done';
      }
      request.finalized_at = 'done';
    });

    const first = await runScheduledWithdrawals(db, '2026-06-04', { finalizeRequest });
    const second = await runScheduledWithdrawals(db, '2026-06-04', { finalizeRequest });

    expect(first.accountProcessed).toBe(2);
    expect(second.accountProcessed).toBe(0);
    expect(finalizeRequest).toHaveBeenCalledTimes(2);
    expect(finalizeRequest.mock.calls.map(call => call[0].path)).toEqual([
      'leave_requests/pause-due',
      'leave_requests/end-due',
    ]);
  });

  it('계정 요청 실패를 격리하고 다음 요청을 계속 처리한다', async () => {
    const db = makeDb([], [
      ['fails', {
        status: 'approved',
        request_type: '휴원요청',
        leave_start_date: '2026-06-04',
        account_target: { account_id: 'regular-1' },
      }],
      ['succeeds', {
        status: 'approved',
        request_type: '퇴원요청',
        withdrawal_date: '2026-06-04',
        account_target: { account_id: 'special-1' },
      }],
    ]);
    const finalizeRequest = vi.fn(async ref => {
      if (ref.path.endsWith('/fails')) throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runScheduledWithdrawals(db, '2026-06-04', { finalizeRequest });

    expect(result.accountProcessed).toBe(1);
    expect(result.accountFailures).toEqual([{ requestId: 'fails', message: 'boom' }]);
    expect(finalizeRequest).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
