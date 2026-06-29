import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '<serverTimestamp>' },
}));

const { handleEditStaffAttendance } = await import('../src/staffAttendanceEditHandler.js');

const auth = { uid: 'u1', token: { email: 'manager@impact7.kr', email_verified: true } };

// HR_users 역할 조회(assertManagerOrAbove) + staff_attendance get/set(merge)을 흉내내는 mock.
function makeFirestore({ attendance, role = 'manager' } = {}) {
  const sets = [];
  const attRef = {
    id: 'doc',
    async get() {
      return attendance ? { exists: true, data: () => attendance } : { exists: false };
    },
    async set(data, opts) { sets.push({ data, opts }); },
  };
  return {
    _sets: sets,
    collection(name) {
      if (name === 'HR_users') {
        return { doc: () => ({ get: async () => (role ? { exists: true, data: () => ({ role }) } : { exists: false }) }) };
      }
      return { doc: () => attRef }; // staff_attendance
    },
  };
}

const validInput = {
  date: '2026-06-30',
  staffId: 'st1',
  arriveAt: '2026-06-30T00:05:00.000Z',
  departAt: '2026-06-30T09:00:00.000Z',
  memo: '지각 보정',
};

describe('handleEditStaffAttendance — 인증/권한', () => {
  it('미인증은 거부(unauthenticated)', async () => {
    await expect(handleEditStaffAttendance({ data: validInput }, { firestore: makeFirestore({ attendance: {} }) }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('비-impact7 계정은 거부(permission-denied)', async () => {
    await expect(handleEditStaffAttendance(
      { auth: { uid: 'u', token: { email: 'x@example.com' } }, data: validInput },
      { firestore: makeFirestore({ attendance: {} }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('비-manager(staff)는 거부(permission-denied)', async () => {
    await expect(handleEditStaffAttendance(
      { auth, data: validInput },
      { firestore: makeFirestore({ attendance: {}, role: 'staff' }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('owner/principal도 허용', async () => {
    for (const role of ['owner', 'principal']) {
      const firestore = makeFirestore({ attendance: { state: '퇴근' }, role });
      const res = await handleEditStaffAttendance({ auth, data: validInput }, { firestore });
      expect(res).toEqual({ ok: true });
    }
  });
});

describe('handleEditStaffAttendance — 편집', () => {
  it('유효 manager 편집 → arriveAt/departAt/memo·edited 반영', async () => {
    const firestore = makeFirestore({ attendance: { state: '퇴근', arriveAt: 'old' } });
    const res = await handleEditStaffAttendance({ auth, data: validInput }, { firestore });
    expect(res).toEqual({ ok: true });
    expect(firestore._sets).toHaveLength(1);
    const { data, opts } = firestore._sets[0];
    expect(opts).toMatchObject({ merge: true });
    expect(data).toMatchObject({
      arriveAt: validInput.arriveAt,
      departAt: validInput.departAt,
      memo: '지각 보정',
      edited: true,
      editedBy: 'u1',
    });
    expect(data.editedAt).toBe('<serverTimestamp>');
  });

  it('제공된 필드만 갱신(memo만) — arriveAt/departAt는 건드리지 않음', async () => {
    const firestore = makeFirestore({ attendance: { state: '근무중' } });
    await handleEditStaffAttendance({ auth, data: { date: '2026-06-30', staffId: 'st1', memo: '메모만' } }, { firestore });
    const { data } = firestore._sets[0];
    expect(data).toMatchObject({ memo: '메모만', edited: true });
    expect('arriveAt' in data).toBe(false);
    expect('departAt' in data).toBe(false);
  });

  it('null은 해당 시각을 지움(merge로 null 기록)', async () => {
    const firestore = makeFirestore({ attendance: { state: '근무중', arriveAt: 'x' } });
    await handleEditStaffAttendance({ auth, data: { date: '2026-06-30', staffId: 'st1', arriveAt: null } }, { firestore });
    expect(firestore._sets[0].data.arriveAt).toBeNull();
  });
});

describe('handleEditStaffAttendance — not-found/invalid-argument', () => {
  it('없는 문서는 not-found', async () => {
    await expect(handleEditStaffAttendance({ auth, data: validInput }, { firestore: makeFirestore({ attendance: undefined }) }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('잘못된 date 형식은 invalid-argument', async () => {
    await expect(handleEditStaffAttendance(
      { auth, data: { date: '2026/06/30', staffId: 'st1' } },
      { firestore: makeFirestore({ attendance: {} }) },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('staffId 누락은 invalid-argument', async () => {
    await expect(handleEditStaffAttendance(
      { auth, data: { date: '2026-06-30' } },
      { firestore: makeFirestore({ attendance: {} }) },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('arriveAt가 유효 ISO가 아니면 invalid-argument', async () => {
    await expect(handleEditStaffAttendance(
      { auth, data: { date: '2026-06-30', staffId: 'st1', arriveAt: 'not-a-date' } },
      { firestore: makeFirestore({ attendance: {} }) },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('memo가 문자열이 아니면 invalid-argument', async () => {
    await expect(handleEditStaffAttendance(
      { auth, data: { date: '2026-06-30', staffId: 'st1', memo: 123 } },
      { firestore: makeFirestore({ attendance: {} }) },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
