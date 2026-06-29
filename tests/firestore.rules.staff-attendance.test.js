import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, getDocs, collection, updateDoc } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx } from './firestore-rules-helpers.js';

describe('staff_attendance: director/manager read 허용, write 차단', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-staff-attendance'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => { await env.clearFirestore(); });

  async function seed(path, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), data);
    });
  }

  async function setupDirector(uid = 'director_uid') {
    await seed(`HR_users/${uid}`, { role: 'principal' });
    return authedCtx(env, uid);
  }

  async function setupManager(uid = 'manager_uid') {
    await seed(`HR_users/${uid}`, { role: 'manager' });
    return authedCtx(env, uid);
  }

  test('director: staff_attendance/{docId} read 허용', async () => {
    await seed('staff_attendance/emp001', {
      name: '김강사',
      checkInTime: new Date('2026-06-28T09:00:00Z'),
      checkOutTime: new Date('2026-06-28T18:00:00Z'),
    });
    const directorDb = await setupDirector('director1');
    await assertSucceeds(getDoc(doc(directorDb, 'staff_attendance/emp001')));
  });

  test('manager: staff_attendance/{docId} read 허용', async () => {
    await seed('staff_attendance/emp002', {
      name: '이직원',
      checkInTime: new Date('2026-06-28T09:00:00Z'),
      checkOutTime: new Date('2026-06-28T18:00:00Z'),
    });
    const managerDb = await setupManager('manager1');
    await assertSucceeds(getDoc(doc(managerDb, 'staff_attendance/emp002')));
  });

  test('director: staff_attendance/{docId} write 거부', async () => {
    await seed('staff_attendance/emp003', {
      name: '박관리',
      checkInTime: new Date('2026-06-28T09:00:00Z'),
    });
    const directorDb = await setupDirector('director2');
    await assertFails(updateDoc(doc(directorDb, 'staff_attendance/emp003'), {
      checkOutTime: new Date('2026-06-28T18:00:00Z'),
    }));
  });

  test('manager: staff_attendance/{docId} write 거부', async () => {
    await seed('staff_attendance/emp004', {
      name: '이관리',
      checkInTime: new Date('2026-06-28T09:00:00Z'),
    });
    const managerDb = await setupManager('manager2');
    await assertFails(updateDoc(doc(managerDb, 'staff_attendance/emp004'), {
      checkOutTime: new Date('2026-06-28T18:00:00Z'),
    }));
  });

  test('unauthed: staff_attendance/{docId} read 거부', async () => {
    await seed('staff_attendance/emp005', {
      name: '우공개',
      checkInTime: new Date('2026-06-28T09:00:00Z'),
    });
    const unauthedDb = unauthedCtx(env);
    await assertFails(getDoc(doc(unauthedDb, 'staff_attendance/emp005')));
  });

  test('unauthed: staff_attendance/{docId} write 거부', async () => {
    await seed('staff_attendance/emp006', {
      name: '최미승',
      checkInTime: new Date('2026-06-28T09:00:00Z'),
    });
    const unauthedDb = unauthedCtx(env);
    await assertFails(updateDoc(doc(unauthedDb, 'staff_attendance/emp006'), {
      checkOutTime: new Date('2026-06-28T18:00:00Z'),
    }));
  });

  test('director: staff_attendance 컬렉션 list 가능', async () => {
    await seed('staff_attendance/emp007', { name: '정사람1' });
    await seed('staff_attendance/emp008', { name: '정사람2' });
    const directorDb = await setupDirector('director3');
    await assertSucceeds(getDocs(collection(directorDb, 'staff_attendance')));
  });

  test('manager: staff_attendance 컬렉션 list 가능', async () => {
    await seed('staff_attendance/emp009', { name: '정사람3' });
    await seed('staff_attendance/emp010', { name: '정사람4' });
    const managerDb = await setupManager('manager3');
    await assertSucceeds(getDocs(collection(managerDb, 'staff_attendance')));
  });
});
