import { describe, expect, it } from 'vitest';

const { buildAttendanceNotificationGaps, previousKstDate, runAttendanceNotificationGapSnapshot } = await import('../src/attendanceNotificationGap.js');

describe('attendance notification gaps', () => {
  it('uses the previous KST date', () => {
    expect(previousKstDate(new Date('2026-07-14T06:00:00.000Z'))).toBe('2026-07-13');
  });

  it('keeps attended students without a matching sent notification', () => {
    const items = buildAttendanceNotificationGaps({
      daily: [
        { student_id: 's1', attendance: { status: '출석' } },
        { student_id: 's2', attendance: { status: '지각' } },
        { student_id: 's3', attendance: { status: '조퇴' } },
        { student_id: 's4', attendance: { status: '결석' } },
      ],
      checkins: [
        { student_id: 's1', status: '출석', queue_id: 'q1' },
        { student_id: 's2', status: '지각', queue_id: 'q2' },
      ],
      events: [{ student_id: 's3', type: '하원', queue_ids: ['q3'] }],
      queueStatuses: new Map([['q1', 'sent'], ['q2', 'failed_permanent'], ['q3', 'awaiting_delivery_result']]),
      studentNames: new Map([['s1', '가학생'], ['s2', '나학생'], ['s3', '다학생'], ['s4', '라학생']]),
    });

    expect(items).toEqual([
      expect.objectContaining({ student_id: 's2', attendance_status: '지각', notification_status: 'failed' }),
      expect.objectContaining({ student_id: 's3', attendance_status: '조퇴', notification_status: 'pending' }),
    ]);
  });

  it('writes the previous-day snapshot at the scheduled boundary', async () => {
    const saved = {};
    const rows = {
      daily_records: [{ student_id: 's1', attendance: { status: '출석' } }],
      attendance_checkins: [{ student_id: 's1', status: '출석', queue_id: 'q1' }],
      attendance_events: [],
    };
    const firestore = {
      collection(name) {
        return {
          where: () => ({ get: async () => ({ docs: (rows[name] ?? []).map((data) => ({ data: () => data })) }) }),
          doc: (id) => ({ id, collectionName: name, set: async (data) => { saved[id] = data; } }),
        };
      },
      async getAll(...refs) {
        return refs.map((ref) => ({
          id: ref.id,
          exists: true,
          data: () => ref.collectionName === 'message_queue' ? { status: 'failed_permanent' } : { name: '가학생' },
        }));
      },
    };

    const result = await runAttendanceNotificationGapSnapshot({
      firestore,
      now: new Date('2026-07-14T05:30:00.000Z'),
    });

    expect(result).toEqual({ dateKST: '2026-07-13', attendedCount: 1, missingCount: 1 });
    expect(saved['2026-07-13'].items[0]).toMatchObject({ student_name: '가학생', notification_status: 'failed' });
  });
});
