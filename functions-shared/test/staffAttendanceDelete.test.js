import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
}));

const { handleDeleteStaffAttendance } = await import('../src/staffAttendanceDeleteHandler.js');

const auth = { uid: 'u1', token: { email: 'owner@impact7.kr', email_verified: true } };

// HR_users 역할 조회(assertDirector) + staff_attendance where(staffId) 쿼리/배치 삭제를 흉내내는 mock.
function makeFirestore({ docCount = 0, role = 'owner' } = {}) {
  const deleted = [];
  const docs = Array.from({ length: docCount }, (_, i) => ({ ref: { id: `${i}` } }));
  return {
    _deleted: deleted,
    collection(name) {
      if (name === 'HR_users') {
        return { doc: () => ({ get: async () => (role ? { exists: true, data: () => ({ role }) } : { exists: false }) }) };
      }
      // staff_attendance
      return { where: () => ({ get: async () => ({ docs }) }) };
    },
    batch() {
      return {
        delete(ref) { deleted.push(ref); },
        async commit() {},
      };
    },
  };
}

describe('handleDeleteStaffAttendance — 인증/권한', () => {
  it('미인증은 거부(unauthenticated)', async () => {
    await expect(handleDeleteStaffAttendance({ data: { staffId: 'st1' } }, { firestore: makeFirestore() }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('비-impact7 계정은 거부(permission-denied)', async () => {
    await expect(handleDeleteStaffAttendance(
      { auth: { uid: 'u', token: { email: 'x@example.com' } }, data: { staffId: 'st1' } },
      { firestore: makeFirestore() },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('비-원장(manager)은 거부(permission-denied)', async () => {
    await expect(handleDeleteStaffAttendance(
      { auth, data: { staffId: 'st1' } },
      { firestore: makeFirestore({ role: 'manager' }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('handleDeleteStaffAttendance — 동작', () => {
  it('staffId 누락은 거부(invalid-argument)', async () => {
    await expect(handleDeleteStaffAttendance({ auth, data: {} }, { firestore: makeFirestore() }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('레코드가 없으면 deleted:0', async () => {
    const fs = makeFirestore({ docCount: 0 });
    const res = await handleDeleteStaffAttendance({ auth, data: { staffId: 'st1' } }, { firestore: fs });
    expect(res).toEqual({ ok: true, deleted: 0 });
    expect(fs._deleted).toHaveLength(0);
  });

  it('해당 staffId 레코드를 모두 삭제(배치 한도 초과도 분할 처리)', async () => {
    const fs = makeFirestore({ docCount: 501 });
    const res = await handleDeleteStaffAttendance({ auth, data: { staffId: 'st1' } }, { firestore: fs });
    expect(res).toEqual({ ok: true, deleted: 501 });
    expect(fs._deleted).toHaveLength(501);
  });
});
