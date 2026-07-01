import { test, expect, vi } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));
import { handleTabletAttendanceLog } from '../src/attendanceLogHandler.js';

const AUTH = { token: { email: 'sr@impact7.kr', email_verified: true } };
function makeFs({ events = [], daily = {}, students = {} }) {
  const q = (rows) => ({ where() { return this; }, async get() { return { docs: rows.map((d) => ({ id: d.id, data: () => d })) }; } });
  return {
    collection(name) {
      if (name === 'attendance_events') return q(events);
      if (name === 'daily_records') return q(Object.entries(daily).map(([id, d]) => ({ id, ...d })));
      if (name === 'students') return q(Object.entries(students).map(([id, d]) => ({ id, ...d })));
      return q([]);
    },
  };
}

test('미인증 거부', async () => {
  await expect(handleTabletAttendanceLog({ auth: null, data: {} }, { firestore: makeFs({}) }))
    .rejects.toMatchObject({ code: 'unauthenticated' });
});

test('오늘 events/daily/students 반환(occurred_at ISO)', async () => {
  const fs = makeFs({
    events: [{ id: 'e1', student_id: 's1', student_name: '홍길동', type: '등원', occurred_at: { toDate: () => new Date('2026-07-01T06:05:00Z') } }],
    daily: { 's1_2026-07-01': { student_id: 's1', day_state: '원내', attendance: { status: '지각' } } },
    students: { s1: { name: '홍길동', status: '재원' } },
  });
  const res = await handleTabletAttendanceLog({ auth: AUTH, data: {} }, { firestore: fs });
  expect(res.events[0]).toMatchObject({ student_id: 's1', type: '등원', occurred_at: '2026-07-01T06:05:00.000Z' });
  expect(res.daily.s1.day_state).toBe('원내');
  expect(res.students).toEqual([{ student_id: 's1', name: '홍길동' }]);
});
