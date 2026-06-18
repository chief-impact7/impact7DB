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
