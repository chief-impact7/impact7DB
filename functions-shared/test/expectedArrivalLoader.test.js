import { test, expect, vi } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));
import {
  findSpecialVisit, loadExpectedArrival, loadExpectedArrivalContext,
} from '../src/expectedArrivalLoader.js';

// students/class_settings/daily_records = doc().get(); tasks/absences = where().get()
function makeFs({ student = {}, classSettings = {}, daily = null, hwTasks = [], testTasks = [], absences = [] }) {
  const q = (rows) => ({ where() { return this; }, async get() { return { docs: rows.map((d) => ({ data: () => d })) }; } });
  return {
    collection(name) {
      if (name === 'class_settings') return { doc: (id) => ({ async get() { return { exists: !!classSettings[id], data: () => classSettings[id] }; } }) };
      if (name === 'students') return { doc: () => ({ async get() { return { exists: true, data: () => student }; } }) };
      if (name === 'daily_records') return { doc: () => ({ async get() { return { exists: !!daily, data: () => daily }; } }) };
      if (name === 'hw_fail_tasks') return q(hwTasks);
      if (name === 'test_fail_tasks') return q(testTasks);
      if (name === 'absence_records') return q(absences);
      return q([]);
    },
  };
}

test('정규 시간표만 있는 학생의 예정시각', async () => {
  const fs = makeFs({
    student: { enrollments: [{ class_type: '정규', level_symbol: 'HA', class_number: '101', day: '수', start_date: '2026-01-01' }] },
    classSettings: { HA101: { schedule: { 수: '17:00' } } },
  });
  expect(await loadExpectedArrival(fs, 's1', '2026-07-01')).toBe('17:00'); // 수요일
});

test('데이터 없으면 빈 문자열', async () => {
  expect(await loadExpectedArrival(makeFs({ student: { enrollments: [] } }), 's1', '2026-07-01')).toBe('');
});

test('결석 보충 makeup_time 반영', async () => {
  const fs = makeFs({
    student: { enrollments: [] },
    absences: [{ resolution: '보충', makeup_date: '2026-07-01', status: 'pending', makeup_status: 'pending', makeup_time: '14:00' }],
  });
  expect(await loadExpectedArrival(fs, 's1', '2026-07-01')).toBe('14:00');
});

test('휴원 학생의 당일 특강 출결 대상과 예정시각을 함께 반환', async () => {
  const fs = makeFs({
    student: {
      enrollments: [
        { class_type: '정규', level_symbol: 'HS', class_number: '201', day: ['수'], start_date: '2026-01-01' },
        { class_type: '특강', class_number: '여름특강A', day: ['수'], start_date: '2026-07-01', end_date: '2026-07-31' },
      ],
    },
    classSettings: {
      HS201: { schedule: { 수: '19:30' } },
      여름특강A: { schedule: { 수: '12:30' } },
    },
  });

  await expect(loadExpectedArrivalContext(fs, 's1', '2026-07-01')).resolves.toEqual({
    expectedArrival: '12:30',
    specialVisit: { code: '여름특강A', scheduled_time: '12:30' },
  });
});

test('특강이 여러 개면 한 자리 시각도 분 단위로 비교해 가장 이른 수업을 선택', () => {
  const enrollments = [
    { class_type: '특강', class_number: '오전', day: ['수'], start_time: '9:30' },
    { class_type: '특강', class_number: '오후', day: ['수'], start_time: '10:00' },
  ];
  expect(findSpecialVisit(enrollments, {}, '2026-07-01')).toEqual({
    code: '오전', scheduled_time: '9:30',
  });
});

test('당일이 아닌 특강은 출결 대상으로 선택하지 않음', () => {
  const enrollments = [
    { class_type: '특강', class_number: '미래', day: ['수'], start_date: '2026-07-02', start_time: '12:30' },
    { class_type: '특강', class_number: '다른요일', day: ['목'], start_time: '12:30' },
  ];
  expect(findSpecialVisit(enrollments, {}, '2026-07-01')).toBeNull();
});
