import { describe, test, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

import { handleStaffCheckin } from '../src/staffCheckinHandler.js';

const AUTH = { token: { email: 'staff@impact7.kr', email_verified: true } };

// staff / staff_attendance 를 메모리로 흉내내는 mock. 확정 단계는 runTransaction 사용.
function makeFirestore({ staff = {}, attendance = {} } = {}) {
  const stores = { staff, staff_attendance: attendance };
  function col(name) {
    const store = stores[name] || {};
    return {
      where(field, op, val) {
        return { async get() {
          const docs = Object.entries(store)
            .filter(([, d]) => d[field] === val)
            .map(([id, d]) => ({ id, data: () => d }));
          return { docs };
        } };
      },
      doc(id) {
        return {
          id,
          async get() { return { exists: !!store[id], id, data: () => store[id] }; },
        };
      },
    };
  }
  return {
    collection: col,
    async runTransaction(fn) {
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, data, opts) {
          const store = stores[ref._col];
          store[ref.id] = opts?.merge ? { ...(store[ref.id] || {}), ...data } : data;
        },
      };
      // doc() 가 _col 을 모르므로, 확정 경로용 ref 빌더를 별도로 제공.
      tx.get = async (ref) => ({ exists: !!stores[ref._col][ref.id], id: ref.id, data: () => stores[ref._col][ref.id] });
      return fn(tx);
    },
    _ref(colName, id) { return { _col: colName, id, get: async () => ({ exists: !!stores[colName][id], id, data: () => stores[colName][id] }) }; },
  };
}

describe('handleStaffCheckin 조회', () => {
  test('미인증 계정은 거부', async () => {
    const firestore = makeFirestore();
    await expect(handleStaffCheckin({ auth: null, data: { phoneKey: '123456' } }, { firestore }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('active 직원만 후보, 미출근이면 출근 액션', async () => {
    const firestore = makeFirestore({
      staff: {
        st1: { name: '김선생', englishName: 'Kim', phoneKey: '123456', status: 'active' },
        st2: { name: '박퇴직', phoneKey: '123456', status: 'terminated' },
      },
      attendance: {},
    });
    const res = await handleStaffCheckin({ auth: AUTH, data: { phoneKey: '123456' } }, { firestore });
    expect(res.result).toBe('candidates');
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({ kind: 'staff', name: '김선생', englishName: 'Kim', dayState: '미출근' });
    expect(res.candidates[0].allowedActions).toEqual(['출근']);
  });
});

describe('handleStaffCheckin 확정', () => {
  test('출근 확정 → state 근무중, created', async () => {
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: {},
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })}_st1`) },
    );
    expect(res.result).toBe('created');
    expect(res.dayState).toBe('근무중');
    expect(res.action).toBe('출근');
  });

  test('미출근에서 퇴근은 거부(failed-precondition)', async () => {
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: {},
    });
    await expect(handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '퇴근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })}_st1`) },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('staffId와 phoneKey 불일치는 거부(failed-precondition)', async () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: {},
    });
    await expect(handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '999999', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${dateStr}_st1`) },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('동일 액션 20초 내 반복은 duplicate', async () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: { [`${dateStr}_st1`]: { state: '근무중', last_event: { action: '출근', at_ms: Date.now() - 5000 } } },
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${dateStr}_st1`) },
    );
    expect(res.result).toBe('duplicate');
    expect(res.dayState).toBe('근무중');
  });
});
