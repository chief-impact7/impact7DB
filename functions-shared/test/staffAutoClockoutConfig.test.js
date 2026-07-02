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

const { handleStaffAutoClockout } = await import('../src/staffAutoClockoutHandler.js');

const PREV_DATE = '2026-07-01';

function makeFirestore({ attendanceDocs = [], staffDocs = {}, settings = null } = {}) {
  const updates = [];
  let committed = false;

  const batch = {
    update(ref, data) { updates.push({ id: ref.id, data }); },
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
          doc(id) {
            return {
              async get() {
                const d = staffDocs[id];
                return d ? { exists: true, data: () => d } : { exists: false };
              },
            };
          },
        };
      }
      // staff_attendance
      const q = {
        where() { return q; },
        async get() {
          return {
            docs: attendanceDocs.map((d, i) => ({
              id: d._id || `doc${i}`,
              ref: { id: d._id || `doc${i}` },
              data: () => d,
            })),
          };
        },
      };
      return q;
    },
    batch: () => batch,
    _updates: updates,
    _committed: () => committed,
  };
}

describe('handleStaffAutoClockout — settings 기반 퇴근 시각', () => {
  it('byStaff 시각으로 퇴근 기록', async () => {
    const settings = {
      dayStartHour: 6,
      autoClockOut: { global: '22:30', byDept: {}, byStaff: { 'st1': '21:00' } },
      autoClockIn: { global: null, byDept: {}, byStaff: {} },
    };
    const expectedISO = new Date(`${PREV_DATE}T21:00:00+09:00`).toISOString();
    const fs = makeFirestore({
      attendanceDocs: [{ _id: 'att1', staffId: 'st1', state: '근무중', events: [] }],
      settings,
    });
    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ date: PREV_DATE, processed: 1, skipped: 0 });
    expect(fs._updates[0].data.departAt).toBe(expectedISO);
  });

  it('byDept 시각으로 퇴근 기록', async () => {
    const settings = {
      dayStartHour: 6,
      autoClockOut: { global: '22:30', byDept: { '교수': '23:00' }, byStaff: {} },
      autoClockIn: { global: null, byDept: {}, byStaff: {} },
    };
    const expectedISO = new Date(`${PREV_DATE}T23:00:00+09:00`).toISOString();
    const fs = makeFirestore({
      attendanceDocs: [{ _id: 'att2', staffId: 'st2', state: '근무중', events: [] }],
      staffDocs: { 'st2': { department: '교수', status: 'active' } },
      settings,
    });
    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 1 });
    expect(fs._updates[0].data.departAt).toBe(expectedISO);
  });

  it('autoClockOut null이면 스킵', async () => {
    const settings = {
      dayStartHour: 6,
      autoClockOut: { global: null, byDept: {}, byStaff: {} },
      autoClockIn: { global: null, byDept: {}, byStaff: {} },
    };
    const fs = makeFirestore({
      attendanceDocs: [{ _id: 'att3', staffId: 'st3', state: '근무중', events: [] }],
      settings,
    });
    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 0, skipped: 1 });
    expect(fs._updates).toHaveLength(0);
    expect(fs._committed()).toBe(false);
  });

  it('직원별 설정 혼합 — 일부 처리·일부 스킵', async () => {
    const settings = {
      dayStartHour: 6,
      autoClockOut: { global: null, byDept: {}, byStaff: { 'st1': '22:00' } },
      autoClockIn: { global: null, byDept: {}, byStaff: {} },
    };
    const fs = makeFirestore({
      attendanceDocs: [
        { _id: 'att1', staffId: 'st1', state: '근무중', events: [] },
        { _id: 'att2', staffId: 'st2', state: '근무중', events: [] },
      ],
      settings,
    });
    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 1, skipped: 1 });
    expect(fs._updates).toHaveLength(1);
  });

  it('settings 없으면 자동 퇴근 안 함 — processed 0, commit 안 함', async () => {
    const fs = makeFirestore({
      attendanceDocs: [{ _id: 'att1', staffId: 'st1', state: '근무중', events: [] }],
      settings: null,
    });
    const res = await handleStaffAutoClockout({ firestore: fs, prevDate: PREV_DATE });
    expect(res).toMatchObject({ processed: 0, skipped: 1 });
    expect(fs._updates).toHaveLength(0);
    expect(fs._committed()).toBe(false);
  });
});
