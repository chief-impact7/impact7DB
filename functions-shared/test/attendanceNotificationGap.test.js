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
        { student_id: 's1', kind: 'parent_notice', template_key: 'report', report_date_kst: '2026-07-13', status: 'sent' },
        { student_id: 's2', kind: 'direct', source: 'parent_report', report_date_kst: '2026-07-13', status: 'failed_permanent' },
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

  it('recognizes legacy report notices by their report variables without accepting other notices', () => {
    const result = buildAttendanceNotificationGaps({
      dateKST: '2026-07-13',
      daily: [
        { student_id: 's1', attendance: { status: '출석' } },
        { student_id: 's2', attendance: { status: '출석' } },
        { student_id: 's3', attendance: { status: '출석' } },
      ],
      students: [
        { id: 's1', name: '가학생', enrollments: [REGULAR] },
        { id: 's2', name: '나학생', enrollments: [REGULAR] },
        { id: 's3', name: '다학생', enrollments: [REGULAR] },
      ],
      classSettings: {},
      queues: [
        { student_id: 's1', kind: 'parent_notice', source: 'manual', status: 'sent', template_variables: { '#{학생명}': '가학생', '#{날짜}': '7/13(월)', '#{내용}': '수업 내용' } },
        { student_id: 's2', kind: 'parent_notice', source: 'manual', status: 'sent', template_variables: { '#{학생명}': '나학생', '#{안내내용}': '일반 안내' } },
        { student_id: 's3', kind: 'parent_notice', template_key: 'report', report_date_kst: '2026-07-14', status: 'sent', template_variables: { '#{학생명}': '다학생', '#{날짜}': '7/14(화)', '#{내용}': '다음 날 수업 내용' } },
      ],
    });

    expect(result.items).toEqual([
      expect.objectContaining({ student_id: 's2', notification_status: 'not_queued' }),
      expect.objectContaining({ student_id: 's3', notification_status: 'not_queued' }),
    ]);
  });

  it('writes the previous-day snapshot at the scheduled boundary', async () => {
    const saved = {};
    const rows = {
      daily_records: [{ student_id: 's1', attendance: { status: '출석' } }],
      message_queue: [{ student_id: 's1', kind: 'parent_notice', template_key: 'report', report_date_kst: '2026-07-13', status: 'failed_permanent' }],
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
            return {
              get: async () => ({
                docs: queues.filter((queue) => (
                  field === 'report_date_kst'
                    ? queue[field] === value
                    : false
                )).map((queue) => ({ data: () => queue })),
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

  it('loads a requested past snapshot and rejects invalid or future dates', async () => {
    const requestedIds = [];
    const firestore = {
      collection(name) {
        if (name === 'attendance_notification_gaps') {
          return { doc: (id) => ({ get: async () => {
            requestedIds.push(id);
            return { exists: false };
          } }) };
        }
        return { where: () => ({ get: async () => ({ docs: [] }) }) };
      },
    };
    const deps = { firestore, now: new Date('2026-07-16T06:00:00.000Z') };
    const auth = { uid: 'u1', token: { email: 'staff@impact7.kr' } };

    await expect(handleGetAttendanceNotificationGaps(
      { auth, data: { dateKST: '2026-07-10' } },
      deps,
    )).resolves.toMatchObject({ dateKST: '2026-07-10', generated: false });
    expect(requestedIds).toEqual(['2026-07-10']);

    await expect(handleGetAttendanceNotificationGaps(
      { auth, data: { dateKST: '2026-02-30' } },
      deps,
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(handleGetAttendanceNotificationGaps(
      { auth, data: { dateKST: '2026-07-10/hidden/doc' } },
      deps,
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(handleGetAttendanceNotificationGaps(
      { auth, data: { dateKST: '2026-07-16' } },
      deps,
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
