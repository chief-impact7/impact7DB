import { describe, expect, it } from 'vitest';

const {
  buildAttendanceNotificationGaps,
  handleGetAttendanceNotificationGaps,
  previousKstDate,
  runAttendanceNotificationGapSnapshot,
} = await import('../src/attendanceNotificationGap.js');

const REGULAR = { class_type: '정규', level_symbol: 'HA', class_number: '101', day: ['월'], start_date: '2026-01-01' };

describe('parent report gaps for regular attendance', () => {
  it('uses the previous KST date', () => {
    expect(previousKstDate(new Date('2026-07-14T06:00:00.000Z'))).toBe('2026-07-13');
  });

  it('keeps regular and free-semester attendees without a sent parent report and excludes special classes', () => {
    const result = buildAttendanceNotificationGaps({
      dateKST: '2026-07-13',
      daily: [
        { student_id: 's1', attendance: { status: '출석' } },
        { student_id: 's2', attendance: { status: '지각' } },
        { student_id: 's3', attendance: { status: '조퇴' } },
      ],
      students: [
        { id: 's1', name: '가학생', enrollments: [REGULAR] },
        { id: 's2', name: '나학생', enrollments: [{ ...REGULAR, class_type: '자유학기', class_number: '102' }] },
        { id: 's3', name: '다학생', enrollments: [{ ...REGULAR, class_type: '특강' }] },
      ],
      classSettings: { HA102: { teacher: 'edward@impact7.kr' } },
      queues: [
        { student_id: 's1', kind: 'parent_notice', template_key: 'report', status: 'sent' },
        { student_id: 's2', kind: 'direct', source: 'parent_report', status: 'failed_permanent' },
      ],
    });

    expect(result.attendedCount).toBe(2);
    expect(result.items).toEqual([
      expect.objectContaining({
        student_id: 's2',
        class_name: 'HA102',
        teacher_name: 'Edward',
        attendance_status: '지각',
        notification_status: 'retry_failed',
      }),
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

  it('refreshes fixed snapshot items from current report queue statuses', async () => {
    const queues = [
      { student_id: 's1', kind: 'direct', source: 'parent_report', status: 'failed_permanent', report_date_kst: '2026-07-13' },
      { student_id: 's1', kind: 'direct', source: 'parent_report', status: 'sent', report_date_kst: '2026-07-13' },
      { student_id: 's2', kind: 'direct', source: 'parent_report', status: 'sent', report_date_kst: '2026-07-12' },
    ];
    const firestore = {
      collection(name) {
        if (name === 'attendance_notification_gaps') {
          return { doc: () => ({ get: async () => ({
            exists: true,
            data: () => ({
              attended_count: 2,
              missing_count: 2,
              items: [
                { student_id: 's1', notification_status: 'not_queued' },
                { student_id: 's2', notification_status: 'not_queued' },
              ],
            }),
          }) }) };
        }
        return {
          where(field, operator, value) {
            expect([field, operator, value]).toEqual(['report_date_kst', '==', '2026-07-13']);
            return {
              get: async () => ({
                docs: queues.filter((queue) => queue[field] === value).map((queue) => ({ data: () => queue })),
              }),
            };
          },
        };
      },
    };

    const result = await handleGetAttendanceNotificationGaps(
      { auth: { uid: 'u1', token: { email: 'staff@impact7.kr' } } },
      { firestore, now: new Date('2026-07-14T06:00:00.000Z') },
    );

    expect(result.missingCount).toBe(1);
    expect(result.items).toEqual([
      expect.objectContaining({ student_id: 's1', notification_status: 'complete', queue_statuses: ['failed_permanent', 'sent'] }),
      expect.objectContaining({ student_id: 's2', notification_status: 'not_queued', queue_statuses: [] }),
    ]);
  });
});
