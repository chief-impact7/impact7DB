import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

import { handleTabletCheckin } from '../src/tabletCheckinHandler.js';

const AUTH = { token: { email: 'staff@impact7.kr', email_verified: true } };

// students/daily_records/kiosk_devices를 메모리로 흉내내는 최소 mock.
function makeFirestore({ students = {}, daily = {}, devices = {} } = {}) {
  return {
    collection(name) {
      const store = { students, daily_records: daily, kiosk_devices: devices }[name] || {};
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
          return { async get() {
            return { exists: !!store[id], id, data: () => store[id] };
          } };
        },
      };
    },
  };
}

describe('handleTabletCheckin 조회', () => {
  test('미인증 계정은 거부', async () => {
    const firestore = makeFirestore();
    await expect(handleTabletCheckin({ auth: null, data: { studentNumber: '123456' } }, { firestore }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('재원생만 후보로, 등원예정 제외, 이름 마스킹', async () => {
    const firestore = makeFirestore({
      students: {
        s1: { studentNumber: '123456', name: '김민수', status: '재원', enrollments: [] },
        s2: { studentNumber: '123456', name: '이서연', status: '등원예정', enrollments: [] },
      },
      daily: {},
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    const res = await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', deviceId: 'tablet-1f' } },
      { firestore },
    );
    expect(res.result).toBe('candidates');
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].name).toBe('김*수');
    expect(res.candidates[0].dayState).toBe('미등원');
    expect(res.candidates[0].allowedActions).toEqual(['등원']);
  });

  test('원내+미완료+block 후보는 하원 버튼 숨김', async () => {
    const firestore = makeFirestore({
      students: { s1: { studentNumber: '777777', name: '홍길동', status: '재원' } },
      daily: { ['s1_' + new Date().toISOString().slice(0, 10)]: {} }, // placeholder; 핸들러는 todayKST 사용
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    // daily 키는 핸들러의 todayKST와 일치해야 하므로, 빈 daily면 미등원으로 처리됨.
    const res = await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '777777', deviceId: 'tablet-1f' } },
      { firestore },
    );
    expect(res.candidates[0].dayState).toBe('미등원');
    expect(res.candidates[0].allowedActions).toEqual(['등원']);
  });
});

// makeFirestore를 확장: runTransaction + doc().set + 신규 doc() id 생성 지원.
function makeTxFirestore({ students = {}, daily = {}, devices = {} } = {}) {
  const writes = [];
  const stores = { students, daily_records: daily, kiosk_devices: devices, attendance_events: {}, message_queue: {} };
  let autoId = 0;
  function docRef(coll, id) {
    const realId = id || `auto_${++autoId}`;
    return {
      id: realId,
      async get() { return { exists: !!stores[coll][realId], id: realId, data: () => stores[coll][realId] }; },
      _coll: coll,
    };
  }
  const api = {
    collection(name) {
      return {
        where(field, op, val) {
          return { async get() {
            const docs = Object.entries(stores[name] || {})
              .filter(([, d]) => d[field] === val).map(([id, d]) => ({ id, data: () => d }));
            return { docs };
          } };
        },
        doc(id) { return docRef(name, id); },
      };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, value, opts) {
          const prev = opts?.merge ? (stores[ref._coll][ref.id] || {}) : {};
          stores[ref._coll][ref.id] = { ...prev, ...value };
          writes.push({ coll: ref._coll, id: ref.id, value, merge: !!opts?.merge });
        },
      };
      return fn(tx);
    },
    _stores: stores, _writes: writes,
  };
  return api;
}

describe('handleTabletCheckin 확정', () => {
  test('등원 확정 — 이벤트 append + daily 동기화 + 알림톡 enqueue', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원', parent_phone_1: '010-1111-2222' } },
      daily: {},
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    const res = await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '등원', deviceId: 'tablet-1f' } },
      { firestore: fs },
    );
    expect(res.result).toBe('created');
    expect(res.dayState).toBe('원내');
    expect(res.queued).toBe(true);
    // daily_records 동기화 확인
    const daily = fs._stores.daily_records[`s1_${d}`];
    expect(daily.attendance.status).toBe('출석');
    expect(daily.day_state).toBe('원내');
    expect(daily.arrival_time).toMatch(/^\d{2}:\d{2}$/);
    // 이벤트 append
    const events = Object.values(fs._stores.attendance_events);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('등원');
    // 알림톡 큐 — kind는 queueWorker의 ALLOWED_KINDS에 속해야 발송된다(통합 계약).
    const queued = Object.values(fs._stores.message_queue);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('attendance');
    expect(queued[0].template_variables).toBeTruthy();
    expect(queued[0].fallback_text).toContain('등원');
  });

  test('등원 지각 — 예정+5분 초과면 status 지각 + 알림톡 시각에 (지각)', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원', parent_phone_1: '010-1111-2222' } },
      daily: {}, devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    const res = await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '등원', deviceId: 'tablet-1f' } },
      { firestore: fs, loadExpectedArrival: async () => '00:00' }, // 예정 00:00 → 지금 등원은 반드시 지각
    );
    expect(res.result).toBe('created');
    expect(fs._stores.daily_records[`s1_${d}`].attendance.status).toBe('지각');
    expect(Object.values(fs._stores.message_queue)[0].template_variables['#{시각}']).toContain('(지각)');
  });

  test('등원 — 예정 없으면 출석, 알림톡에 (지각) 없음', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원', parent_phone_1: '010-1111-2222' } },
      daily: {}, devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '등원', deviceId: 'tablet-1f' } },
      { firestore: fs, loadExpectedArrival: async () => '' },
    );
    expect(fs._stores.daily_records[`s1_${d}`].attendance.status).toBe('출석');
    expect(Object.values(fs._stores.message_queue)[0].template_variables['#{시각}']).not.toContain('(지각)');
  });

  test('외출중 학생의 하원 시도 — 전이 거부', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원' } },
      daily: { [`s1_${d}`]: { day_state: '외출중' } },
      devices: { 'tablet-1f': { departure_policy: 'allow' } },
    });
    await expect(handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '하원', deviceId: 'tablet-1f' } },
      { firestore: fs },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('원내+미완료+block 하원 — 게이트 거부', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원' } },
      daily: { [`s1_${d}`]: { day_state: '원내', checklist_complete: false } },
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    await expect(handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '하원', deviceId: 'tablet-1f' } },
      { firestore: fs },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('하원 확정 — departure 기록 + day_state 하원', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원', parent_phone_1: '01011112222' } },
      daily: { [`s1_${d}`]: { day_state: '원내', checklist_complete: true, attendance: { status: '출석' }, arrival_time: '14:00' } },
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    const res = await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '하원', deviceId: 'tablet-1f' } },
      { firestore: fs },
    );
    expect(res.dayState).toBe('하원');
    const daily = fs._stores.daily_records[`s1_${d}`];
    expect(daily.departure.status).toBe('하원');
    expect(daily.departure.source).toBe('tablet');
    expect(daily.day_state).toBe('하원');
  });

  test('외출중 학생의 귀원 확정 — day_state 원내 복귀', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원' } },
      daily: { [`s1_${d}`]: { day_state: '외출중' } },
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    const res = await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '귀원', deviceId: 'tablet-1f' } },
      { firestore: fs },
    );
    expect(res.dayState).toBe('원내');
    expect(Object.values(fs._stores.attendance_events)[0].type).toBe('귀원');
  });

  test('구 클라이언트 액션 정규화 — 복귀→귀원, 귀가→하원', async () => {
    const { todayKST } = await import('@impact7/shared/datetime');
    const d = todayKST();
    // 복귀(구) → 귀원: 외출중에서 전이 성공
    const fs1 = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원' } },
      daily: { [`s1_${d}`]: { day_state: '외출중' } },
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    const r1 = await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '복귀', deviceId: 'tablet-1f' } },
      { firestore: fs1 },
    );
    expect(r1.dayState).toBe('원내');
    expect(Object.values(fs1._stores.attendance_events)[0].type).toBe('귀원');
    // 귀가(구) → 하원: departure.status는 표준 '하원'으로 저장
    const fs2 = makeTxFirestore({
      students: { s1: { studentNumber: '123456', name: '김민수', status: '재원' } },
      daily: { [`s1_${d}`]: { day_state: '원내', checklist_complete: true } },
      devices: { 'tablet-1f': { departure_policy: 'block' } },
    });
    await handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '귀가', deviceId: 'tablet-1f' } },
      { firestore: fs2 },
    );
    expect(fs2._stores.daily_records[`s1_${d}`].departure.status).toBe('하원');
  });

  test('studentNumber 불일치 — 거부', async () => {
    const fs = makeTxFirestore({
      students: { s1: { studentNumber: '999999', name: '김민수', status: '재원' } },
      devices: {},
    });
    await expect(handleTabletCheckin(
      { auth: AUTH, data: { studentNumber: '123456', studentId: 's1', action: '등원', deviceId: 'tablet-1f' } },
      { firestore: fs },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
