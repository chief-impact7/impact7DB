import { test, expect, vi } from 'vitest';
vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));
import { loadExpectedArrival } from '../src/expectedArrivalLoader.js';

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
