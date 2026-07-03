import { test, expect, vi } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));
import { handleTabletAttendanceLog } from '../src/attendanceLogHandler.js';

const AUTH = { token: { email: 'sr@impact7.kr', email_verified: true } };
const PIN = '123456';

function makeFs({ events = [], daily = {}, students = {}, kiosk = { admin_pin: PIN } }) {
  const q = (rows) => ({ where() { return this; }, async get() { return { docs: rows.map((d) => ({ id: d.id, data: () => d })) }; } });
  const kioskWrites = [];
  const kioskDoc = {
    async get() { return { data: () => (kiosk ? { ...kiosk } : undefined) }; },
    async set(update, opts) { kioskWrites.push({ update, opts }); Object.assign(kiosk ?? {}, update); },
  };
  return {
    kioskWrites,
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set: (ref, update, opts) => { ref.set(update, opts); },
      });
    },
    collection(name) {
      if (name === 'attendance_events') return q(events);
      if (name === 'daily_records') return q(Object.entries(daily).map(([id, d]) => ({ id, ...d })));
      if (name === 'students') return q(Object.entries(students).map(([id, d]) => ({ id, ...d })));
      if (name === 'kiosk_settings') return { doc: () => kioskDoc };
      return q([]);
    },
  };
}

test('미인증 거부', async () => {
  await expect(handleTabletAttendanceLog({ auth: null, data: {} }, { firestore: makeFs({}) }))
    .rejects.toMatchObject({ code: 'unauthenticated' });
});

test('PIN 미설정이면 실패-클로즈드(failed-precondition)', async () => {
  const fs = makeFs({ kiosk: null });
  await expect(handleTabletAttendanceLog({ auth: AUTH, data: { pin: PIN } }, { firestore: fs }))
    .rejects.toMatchObject({ code: 'failed-precondition' });
});

test('PIN이 6자리 숫자가 아니면 미설정으로 취급', async () => {
  const fs = makeFs({ kiosk: { admin_pin: '1234' } });
  await expect(handleTabletAttendanceLog({ auth: AUTH, data: { pin: '1234' } }, { firestore: fs }))
    .rejects.toMatchObject({ code: 'failed-precondition' });
});

test('빈/형식불량 PIN(구버전 클라)은 카운터를 태우지 않고 거부', async () => {
  const fs = makeFs({});
  await expect(handleTabletAttendanceLog({ auth: AUTH, data: {} }, { firestore: fs }))
    .rejects.toMatchObject({ code: 'permission-denied' });
  await expect(handleTabletAttendanceLog({ auth: AUTH, data: { pin: '12' } }, { firestore: fs }))
    .rejects.toMatchObject({ code: 'permission-denied' });
  expect(fs.kioskWrites).toEqual([]);
});

test('PIN 불일치 → permission-denied + 실패 카운트 기록', async () => {
  const fs = makeFs({});
  await expect(handleTabletAttendanceLog({ auth: AUTH, data: { pin: '000000' } }, { firestore: fs }))
    .rejects.toMatchObject({ code: 'permission-denied' });
  expect(fs.kioskWrites).toEqual([{ update: { pin_fail_count: 1 }, opts: { merge: true } }]);
});

test('5회째 실패면 1분 잠금 기록', async () => {
  const now = 1_000_000;
  const fs = makeFs({ kiosk: { admin_pin: PIN, pin_fail_count: 4 } });
  await expect(handleTabletAttendanceLog({ auth: AUTH, data: { pin: '000000' } }, { firestore: fs, now }))
    .rejects.toMatchObject({ code: 'permission-denied' });
  expect(fs.kioskWrites).toEqual([{ update: { pin_fail_count: 0, pin_locked_until: now + 60_000 }, opts: { merge: true } }]);
});

test('잠금 중에는 올바른 PIN도 거부(resource-exhausted)', async () => {
  const now = 1_000_000;
  const fs = makeFs({ kiosk: { admin_pin: PIN, pin_locked_until: now + 30_000 } });
  await expect(handleTabletAttendanceLog({ auth: AUTH, data: { pin: PIN } }, { firestore: fs, now }))
    .rejects.toMatchObject({ code: 'resource-exhausted' });
});

test('올바른 PIN이면 통과 + 잔여 실패 카운트 리셋', async () => {
  const fs = makeFs({ kiosk: { admin_pin: PIN, pin_fail_count: 3 } });
  const res = await handleTabletAttendanceLog({ auth: AUTH, data: { pin: PIN } }, { firestore: fs });
  expect(res).toMatchObject({ events: [], daily: {}, students: [] });
  expect(fs.kioskWrites).toEqual([{ update: { pin_fail_count: 0 }, opts: { merge: true } }]);
});

test('오늘 events/daily/students 반환(occurred_at ISO)', async () => {
  const fs = makeFs({
    events: [{ id: 'e1', student_id: 's1', student_name: '홍길동', type: '등원', occurred_at: { toDate: () => new Date('2026-07-01T06:05:00Z') } }],
    daily: { 's1_2026-07-01': { student_id: 's1', day_state: '원내', attendance: { status: '지각' } } },
    students: { s1: { name: '홍길동', status: '재원' } },
  });
  const res = await handleTabletAttendanceLog({ auth: AUTH, data: { pin: PIN } }, { firestore: fs });
  expect(res.events[0]).toMatchObject({ student_id: 's1', type: '등원', occurred_at: '2026-07-01T06:05:00.000Z' });
  expect(res.daily.s1.day_state).toBe('원내');
  expect(res.students).toEqual([{ student_id: 's1', name: '홍길동' }]);
});
