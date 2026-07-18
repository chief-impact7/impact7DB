import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { syncTeacherEligibility } from '../src/teacherDirectory.js';

let app;
let db;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  app = initializeApp({ projectId: 'impact7db-test' }, 'teacher-directory-integration');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  for (const collectionName of ['staff', 'teachers', 'staff_directory']) {
    const snapshot = await db.collection(collectionName).get();
    await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
  }
});

describe('syncTeacherEligibility', () => {
  it('담임 자격과 보드 명부를 한 번에 안전한 정본으로 맞춘다', async () => {
    await Promise.all([
      db.doc('staff/professor').set({
        name: '김교수',
        englishName: 'Rachel',
        email: 'RACHEL@IMPACT7.KR',
        department: '교수',
        status: 'active',
        residentNumber: '노출 금지',
      }),
      db.doc('staff/admin').set({
        name: '박행정',
        englishName: 'Jane',
        email: 'jane@impact7.kr',
        department: '행정',
        status: 'terminated',
      }),
      db.doc('staff/short-term').set({
        name: '단기',
        englishName: 'Tom',
        email: 'tom@impact7.kr',
        department: '단기',
        status: 'active',
      }),
      db.doc('teachers/rachel@impact7.kr').set({ homeroom_eligible: false, board_assignable: false }),
      db.doc('teachers/jane@impact7.kr').set({ homeroom_eligible: true, board_assignable: true }),
      db.doc('staff_directory/professor').set({ display_name: '과거값', residentNumber: '제거 대상' }),
      db.doc('staff_directory/stale').set({ display_name: '삭제 대상' }),
    ]);

    const result = await syncTeacherEligibility(db);

    expect(result).toMatchObject({ teachers: 2, directory: 2 });
    expect((await db.doc('teachers/rachel@impact7.kr').get()).data()).toMatchObject({
      homeroom_eligible: true,
      board_assignable: true,
    });
    expect((await db.doc('teachers/jane@impact7.kr').get()).data()).toMatchObject({
      homeroom_eligible: false,
      board_assignable: false,
    });
    expect((await db.doc('staff_directory/professor').get()).data()).toEqual({
      display_name: '김교수',
      email: 'rachel@impact7.kr',
      department: '교수',
      assignable: true,
    });
    expect((await db.doc('staff_directory/admin').get()).data()).toEqual({
      display_name: '박행정',
      email: 'jane@impact7.kr',
      department: '행정',
      assignable: false,
    });
    expect((await db.doc('staff_directory/short-term').get()).exists).toBe(false);
    expect((await db.doc('staff_directory/stale').get()).exists).toBe(false);
  });
});
