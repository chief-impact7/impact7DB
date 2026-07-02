import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

vi.mock('@impact7/shared/datetime', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, businessDayKST: vi.fn().mockImplementation(real.businessDayKST) };
});

const { handleStaffAutoClockin } = await import('../src/staffAutoClockinHandler.js');

const PREV_DATE = '2026-07-01';

function makeFirestore({ staffDocs = {}, attendanceDocs = {}, settings = null } = {}) {
  const sets = [];
  let committed = false;

  const batch = {
    set(ref, data) { sets.push({ id: ref.id, data }); },
    async commit() { committed = true; },
  };

  return {
    collection(name) {
      if (name === 'settings') {
        return {
          doc() {
            return {
              async get() {
                return settings
                  ? { exists: true, data: () => settings }
                  : { exists: false };
              },
            };
          },
        };
      }
      if (name === 'staff') {
        return {
          where() {
            return {
              async get() {
                return {
                  empty: Object.keys(staffDocs).length === 0,
                  docs: Object.entries(staffDocs).map(([id, d]) => ({ id, data: () => d })),
                };
              },
            };
          },
        };
      }
      // staff_attendance
      return {
        doc(docId) {
          return {
            id: docId,
            _col: 'staff_attendance',
            async get() {
              const d = attendanceDocs[docId];
              return { exists: !!d, data: () => d };
            },
          };
        },
      };
    },
    batch: () => batch,
    _sets: sets,
    _committed: () => committed,
  };
}

const BASE_SETTINGS = {
  dayStartHour: 6,
  autoClockOut: { global: '22:30', byDept: {}, byStaff: {} },
  autoClockIn: { global: null, byDept: {}, byStaff: {} },
};

describe('handleStaffAutoClockin — 자동 출근 생성', () => {
  it('resolveAutoTime 시각 설정 + 문서 없음 → 출근 문서 생성', async () => {
    const settings = {
      ...BASE_SETTINGS,
      autoClockIn: { global: null, byDept: {}, byStaff: { 'st1': '08:00' } },
    };
    const expectedISO = new Date(`${PREV_DATE}T08:00:00+09:00`).toISOString();
    const fs = makeFirestore({
      staffDocs: { 'st1': { name: '김선생', status: 'active', department: '교수' } },
      attendanceDocs: {},
      settings,
    });
    const res = await handleStaffAutoClockin({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ date: PREV_DATE, processed: 1, skipped: 0 });
    expect(fs._sets).toHaveLength(1);
    expect(fs._sets[0].id).toBe(`${PREV_DATE}_st1`);
    const doc = fs._sets[0].data;
    expect(doc.staffId).toBe('st1');
    expect(doc.state).toBe('근무중');
    expect(doc.arriveAt).toBe(expectedISO);
    expect(doc.events[0].action).toBe('출근');
    expect(doc.updated_by).toBe('system-auto');
    expect(fs._committed()).toBe(true);
  });

  it('byDept 시각으로 출근 생성', async () => {
    const settings = {
      ...BASE_SETTINGS,
      autoClockIn: { global: null, byDept: { '교수': '09:00' }, byStaff: {} },
    };
    const expectedISO = new Date(`${PREV_DATE}T09:00:00+09:00`).toISOString();
    const fs = makeFirestore({
      staffDocs: { 'st2': { name: '박선생', status: 'active', department: '교수' } },
      attendanceDocs: {},
      settings,
    });
    const res = await handleStaffAutoClockin({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 1 });
    expect(fs._sets[0].data.arriveAt).toBe(expectedISO);
  });
});

describe('handleStaffAutoClockin — 스킵 케이스', () => {
  it('resolveAutoTime null → 스킵', async () => {
    const fs = makeFirestore({
      staffDocs: { 'st1': { name: '김선생', status: 'active', department: '교수' } },
      attendanceDocs: {},
      settings: BASE_SETTINGS,
    });
    const res = await handleStaffAutoClockin({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 0, skipped: 1 });
    expect(fs._sets).toHaveLength(0);
    expect(fs._committed()).toBe(false);
  });

  it('이미 출근 문서 있으면 스킵(멱등)', async () => {
    const settings = {
      ...BASE_SETTINGS,
      autoClockIn: { global: null, byDept: {}, byStaff: { 'st1': '08:00' } },
    };
    const fs = makeFirestore({
      staffDocs: { 'st1': { name: '김선생', status: 'active', department: '교수' } },
      attendanceDocs: { [`${PREV_DATE}_st1`]: { staffId: 'st1', state: '근무중' } },
      settings,
    });
    const res = await handleStaffAutoClockin({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 0, skipped: 1 });
    expect(fs._sets).toHaveLength(0);
  });

  it('active 직원 없으면 즉시 반환', async () => {
    const fs = makeFirestore({ staffDocs: {}, settings: BASE_SETTINGS });
    const res = await handleStaffAutoClockin({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 0, skipped: 0 });
  });

  it('settings 없으면 DEFAULT(autoClockIn.global=null) → 전원 스킵', async () => {
    const fs = makeFirestore({
      staffDocs: { 'st1': { name: '김선생', status: 'active' } },
      attendanceDocs: {},
      settings: null,
    });
    const res = await handleStaffAutoClockin({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 0, skipped: 1 });
  });
});

describe('handleStaffAutoClockin — 혼합', () => {
  it('설정된 직원만 처리, 미설정은 스킵', async () => {
    const settings = {
      ...BASE_SETTINGS,
      autoClockIn: { global: null, byDept: {}, byStaff: { 'st1': '08:00' } },
    };
    const fs = makeFirestore({
      staffDocs: {
        'st1': { name: '김선생', status: 'active' },
        'st2': { name: '박선생', status: 'active' },
      },
      attendanceDocs: {},
      settings,
    });
    const res = await handleStaffAutoClockin({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 1, skipped: 1 });
    expect(fs._sets).toHaveLength(1);
    expect(fs._sets[0].id).toBe(`${PREV_DATE}_st1`);
  });
});
