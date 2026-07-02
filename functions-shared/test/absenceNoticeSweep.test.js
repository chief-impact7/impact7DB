import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<ts>' },
}));

const { runAbsenceNoticeSweep } = await import('../src/absenceNoticeSweep.js');

function makeDb({ students = {}, daily = {}, notices = {}, absences = {} } = {}) {
  const stores = {
    students: { ...students }, daily_records: { ...daily },
    absence_notices: { ...notices }, absence_records: { ...absences }, message_queue: {},
  };
  let mqId = 0;
  const coll = (n) => ({
    where(f, op, v) {
      const filters = [[f, op, v]];
      const q = {
        where(f2, op2, v2) { filters.push([f2, op2, v2]); return q; },
        async get() {
          const docs = Object.entries(stores[n])
            .filter(([, d]) => filters.every(([ff, oo, vv]) => (oo === 'in' ? vv.includes(d[ff]) : d[ff] === vv)))
            .map(([id, d]) => ({ id, data: () => d }));
          return { docs, empty: docs.length === 0 };
        },
      };
      return q;
    },
    doc(id) {
      const _id = id ?? `mq${++mqId}`;
      return {
        id: _id,
        async get() { const d = stores[n][_id]; return { exists: d !== undefined, data: () => d }; },
        async create(data) {
          if (stores[n][_id] !== undefined) { const e = new Error('exists'); e.code = 6; throw e; }
          stores[n][_id] = data;
        },
        async set(data) { stores[n][_id] = data; },
        async delete() { delete stores[n][_id]; },
      };
    },
  });
  return { collection: coll, _stores: stores };
}

const NOW = new Date('2026-07-02T10:00:00Z'); // KST 19:00
const D = '2026-07-02';
const student = (over = {}) => ({ status: '재원', name: '김민수', parent_phone_1: '010-1111-2222', ...over });
const run = (db, over = {}) => runAbsenceNoticeSweep({ db, now: NOW, dateKST: D, enabled: true, loadExpectedArrival: async () => '17:00', ...over });

describe('runAbsenceNoticeSweep', () => {
  it('게이트 off → 조회·발송 없이 disabled', async () => {
    const db = makeDb({ students: { s1: student() } });
    const res = await runAbsenceNoticeSweep({ db, enabled: false });
    expect(res).toMatchObject({ disabled: true, sent: 0 });
    expect(Object.keys(db._stores.message_queue)).toHaveLength(0);
  });

  it('재원 미등원 + 예정+유예 경과 + 결석 없음 → parent_notice 발송 + 멱등 기록', async () => {
    const db = makeDb({ students: { s1: student() } });
    const res = await run(db);
    expect(res.sent).toBe(1);
    const q = Object.values(db._stores.message_queue)[0];
    expect(q).toMatchObject({ kind: 'parent_notice', source: 'absence_sweep' });
    expect(q.template_variables['#{학생명}']).toBe('김민수');
    expect(q.fallback_text).toContain('등원하지 않았습니다');
    expect(db._stores.absence_notices[`s1_${D}`]).toBeTruthy();
  });

  it('휴원(실휴원) → 대상 아님(재원만)', async () => {
    const db = makeDb({ students: { s1: student({ status: '실휴원' }) } });
    expect((await run(db)).sent).toBe(0);
  });

  it('이미 체크인(day_state != 미등원) → 제외', async () => {
    const db = makeDb({ students: { s1: student() }, daily: { [`s1_${D}`]: { day_state: '원내' } } });
    expect((await run(db)).sent).toBe(0);
  });

  it('수동 출결·결석 처리(attendance.status) → 제외', async () => {
    const db = makeDb({ students: { s1: student() }, daily: { [`s1_${D}`]: { attendance: { status: '결석' } } } });
    expect((await run(db)).sent).toBe(0);
  });

  it('사전 결석 통보(absence_records 오늘) → 제외', async () => {
    const db = makeDb({ students: { s1: student() }, absences: { a1: { student_id: 's1', absence_date: D } } });
    expect((await run(db)).sent).toBe(0);
  });

  it('수업 없는 날(예정시각 없음) → 제외', async () => {
    const db = makeDb({ students: { s1: student() } });
    expect((await run(db, { loadExpectedArrival: async () => '' })).sent).toBe(0);
  });

  it('유예 내(예정+40분 전) → 제외', async () => {
    const db = makeDb({ students: { s1: student() } });
    expect((await run(db, { loadExpectedArrival: async () => '18:40' })).sent).toBe(0); // 19:00 < 19:20
  });

  it('멱등: absence_notices 이미 존재 → 재발송 안 함', async () => {
    const db = makeDb({ students: { s1: student() }, notices: { [`s1_${D}`]: { student_id: 's1' } } });
    const res = await run(db);
    expect(res.sent).toBe(0);
    expect(Object.keys(db._stores.message_queue)).toHaveLength(0);
  });

  it('학부모 번호 없음 → 제외', async () => {
    const db = makeDb({ students: { s1: student({ parent_phone_1: '', parent_phone_2: '' }) } });
    expect((await run(db)).sent).toBe(0);
  });
});
