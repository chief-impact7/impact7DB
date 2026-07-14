import { describe, expect, it } from 'vitest';

const { buildAttendanceNotificationGaps, previousKstDate, runAttendanceNotificationGapSnapshot } = await import('../src/attendanceNotificationGap.js');

const REGULAR = { class_type: '정규', level_symbol: 'HA', class_number: '101', day: ['월'], start_date: '2026-01-01' };

describe('parent report gaps for regular attendance', () => {
  it('uses the previous KST date', () => {
    expect(previousKstDate(new Date('2026-07-14T06:00:00.000Z'))).toBe('2026-07-13');
  });

  it('keeps regular attendees without a sent parent report and excludes non-regular attendance', () => {
    const result = buildAttendanceNotificationGaps({
      dateKST: '2026-07-13',
      daily: [
        { student_id: 's1', attendance: { status: '출석' } },
        { student_id: 's2', attendance: { status: '지각' } },
        { student_id: 's3', attendance: { status: '조퇴' } },
      ],
      students: [
        { id: 's1', name: '가학생', enrollments: [REGULAR] },
        { id: 's2', name: '나학생', enrollments: [REGULAR] },
        { id: 's3', name: '다학생', enrollments: [{ ...REGULAR, class_type: '특강' }] },
      ],
      classSettings: {},
      queues: [
        { student_id: 's1', kind: 'parent_notice', template_key: 'report', status: 'sent' },
        { student_id: 's2', kind: 'direct', source: 'parent_report', status: 'failed_permanent' },
      ],
    });

    expect(result.attendedCount).toBe(2);
    expect(result.items).toEqual([
      expect.objectContaining({ student_id: 's2', attendance_status: '지각', notification_status: 'retry_failed' }),
    ]);
  });

  it('writes the previous-day snapshot at the scheduled boundary', async () => {
    const saved = {};
    const rows = {
      daily_records: [{ student_id: 's1', attendance: { status: '출석' } }],
      message_queue: [{ student_id: 's1', kind: 'parent_notice', template_key: 'report', status: 'failed_permanent' }],
    };
    const firestore = {
      collection(name) {
        return {
          where: () => ({ get: async () => ({ docs: (rows[name] ?? []).map((data) => ({ data: () => data })) }) }),
          doc: (id) => ({ id, collectionName: name, set: async (data) => { saved[id] = data; } }),
        };
      },
      async getAll(...refs) {
        return refs.map((ref) => {
          if (ref.collectionName === 'students') {
            return { id: ref.id, exists: true, data: () => ({ name: '가학생', enrollments: [REGULAR] }) };
          }
          return { id: ref.id, exists: false, data: () => ({}) };
        });
      },
    };

    const result = await runAttendanceNotificationGapSnapshot({
      firestore,
      now: new Date('2026-07-14T05:30:00.000Z'),
    });

    expect(result).toEqual({ dateKST: '2026-07-13', attendedCount: 1, missingCount: 1 });
    expect(saved['2026-07-13'].items[0]).toMatchObject({ student_name: '가학생', notification_status: 'retry_failed' });
  });
});
