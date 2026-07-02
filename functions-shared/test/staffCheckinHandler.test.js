import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

vi.mock('@impact7/shared/datetime', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, businessDayKST: vi.fn().mockImplementation(real.businessDayKST) };
});

import { handleStaffCheckin } from '../src/staffCheckinHandler.js';
import { businessDayKST } from '@impact7/shared/datetime';

const AUTH = { token: { email: 'staff@impact7.kr', email_verified: true } };

// staff / staff_attendance / message_queue 를 메모리로 흉내내는 mock. 확정 단계는 runTransaction 사용.
function makeFirestore({ staff = {}, attendance = {}, queue = {} } = {}) {
  const stores = { staff, staff_attendance: attendance, message_queue: queue };
  let _autoId = 0;
  function col(name) {
    if (!stores[name]) stores[name] = {};
    const store = stores[name];
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
        const docId = id ?? `auto_${++_autoId}`;
        return {
          _col: name,
          id: docId,
          async get() { return { exists: !!store[docId], id: docId, data: () => store[docId] }; },
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
          if (!stores[ref._col]) stores[ref._col] = {};
          const store = stores[ref._col];
          store[ref.id] = opts?.merge ? { ...(store[ref.id] || {}), ...data } : data;
        },
      };
      // doc() 가 _col 을 모르므로, 확정 경로용 ref 빌더를 별도로 제공.
      tx.get = async (ref) => ({ exists: !!(stores[ref._col] || {})[ref.id], id: ref.id, data: () => (stores[ref._col] || {})[ref.id] });
      return fn(tx);
    },
    _ref(colName, id) { return { _col: colName, id, get: async () => ({ exists: !!stores[colName][id], id, data: () => stores[colName][id] }) }; },
    _queue() { return stores.message_queue; },
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

  test("구 클라이언트 '복귀'는 '귀원'으로 정규화 — 외출중에서 근무중 복귀", async () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: { [`${dateStr}_st1`]: { state: '외출중', last_event: { action: '외출', at_ms: Date.now() - 60000 } } },
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '복귀' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${dateStr}_st1`) },
    );
    expect(res.result).toBe('created');
    expect(res.dayState).toBe('근무중');
    expect(res.action).toBe('귀원');
  });
});

describe('handleStaffCheckin 알림 큐', () => {
  test('attendanceNotifyPhone 있으면 message_queue 1건 적재', async () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active', attendanceNotifyPhone: '01012345678' } },
      attendance: {},
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${dateStr}_st1`) },
    );
    expect(res.result).toBe('created');
    const queue = firestore._queue();
    expect(Object.keys(queue)).toHaveLength(1);
    const doc = Object.values(queue)[0];
    expect(doc.kind).toBe('attendance');
    expect(doc.recipient_phone).toBe('01012345678');
    expect(doc.status).toBe('pending');
    expect(doc.source).toBe('tablet');
    expect(doc.staff_id).toBe('st1');
  });

  test('attendanceNotifyPhone 없으면 message_queue 0건', async () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: {},
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${dateStr}_st1`) },
    );
    expect(res.result).toBe('created');
    expect(Object.keys(firestore._queue())).toHaveLength(0);
  });

  test('duplicate이면 message_queue 0건', async () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active', attendanceNotifyPhone: '01012345678' } },
      attendance: { [`${dateStr}_st1`]: { state: '근무중', last_event: { action: '출근', at_ms: Date.now() - 5000 } } },
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${dateStr}_st1`) },
    );
    expect(res.result).toBe('duplicate');
    expect(Object.keys(firestore._queue())).toHaveLength(0);
  });

  test('attendanceNotifyPhone 있어도 처리(created) 성공 유지', async () => {
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active', attendanceNotifyPhone: '01099998888' } },
      attendance: {},
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${dateStr}_st1`) },
    );
    expect(res.result).toBe('created');
    expect(res.dayState).toBe('근무중');
  });
});

describe('handleStaffCheckin 근무일(businessDate) 경계', () => {
  const BUSINESS_DATE = '2026-06-30'; // 익일 01:00 KST → 전날 근무일

  beforeEach(() => {
    vi.mocked(businessDayKST).mockReturnValue(BUSINESS_DATE);
  });

  afterEach(() => {
    vi.mocked(businessDayKST).mockRestore();
  });

  test('익일 새벽(01:00 KST) 출근 → 전날 근무일 date 문서에 기록', async () => {
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: {},
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '출근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${BUSINESS_DATE}_st1`) },
    );
    expect(res.result).toBe('created');
    expect(res.dayState).toBe('근무중');
    const written = firestore._ref('staff_attendance', `${BUSINESS_DATE}_st1`);
    const snap = await written.get();
    expect(snap.data().date).toBe(BUSINESS_DATE);
    expect(snap.data().yearMonth).toBe('2026-06');
  });

  test('자정 넘긴 퇴근(01:30 KST) → 동일 근무일(전날) 문서에 귀속', async () => {
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: {
        [`${BUSINESS_DATE}_st1`]: { state: '근무중', last_event: { action: '출근', at_ms: Date.now() - 60_000 } },
      },
    });
    const res = await handleStaffCheckin(
      { auth: AUTH, data: { phoneKey: '123456', staffId: 'st1', action: '퇴근' } },
      { firestore, staffRef: firestore._ref('staff', 'st1'), attRef: firestore._ref('staff_attendance', `${BUSINESS_DATE}_st1`) },
    );
    expect(res.result).toBe('created');
    expect(res.dayState).toBe('퇴근');
    const snap = await firestore._ref('staff_attendance', `${BUSINESS_DATE}_st1`).get();
    expect(snap.data().date).toBe(BUSINESS_DATE);
  });

  test('lookup 단계: 전날 근무일 기준 출결 문서 조회', async () => {
    const firestore = makeFirestore({
      staff: { st1: { name: '김선생', phoneKey: '123456', status: 'active' } },
      attendance: {
        [`${BUSINESS_DATE}_st1`]: { state: '근무중', last_event: { action: '출근', at_ms: Date.now() - 3600_000 } },
      },
    });
    const res = await handleStaffCheckin({ auth: AUTH, data: { phoneKey: '123456' } }, { firestore });
    expect(res.result).toBe('candidates');
    expect(res.candidates[0].dayState).toBe('근무중');
    expect(res.candidates[0].allowedActions).toContain('외출');
    expect(res.candidates[0].allowedActions).toContain('퇴근');
  });
});
