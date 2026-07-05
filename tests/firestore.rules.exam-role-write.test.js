import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx, externalCtx } from './firestore-rules-helpers.js';

const TEACHER = { uid: 'teacher1', email: 'teacher1@impact7.kr', displayName: 'T One', role: 'teacher', deptIds: [] };
const OWNER = { uid: 'owner1', email: 'owner1@impact7.kr', displayName: 'O One', role: 'owner', deptIds: [] };

describe('exam 컬렉션 write 역할 제한 — exam_users.role 기반', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-exam-role-write'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'exam_users/teacher1'), TEACHER);
      await setDoc(doc(db, 'exam_users/owner1'), OWNER);
    });
  });

  async function seed(path, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), data);
    });
  }

  const teacher = () => authedCtx(env, 'teacher1');
  const owner = () => authedCtx(env, 'owner1');
  // exam_users 문서 없는 impact7 직원(DB/HR 등) — 프로비저닝 전 상태와 동일
  const noProfile = () => authedCtx(env, 'staff9');

  // ---- 회귀 방지: teacher 워크플로우 PASS ----

  test('teacher: results/students create/update/delete (OCR 채점 핵심)', async () => {
    const db = teacher();
    await assertSucceeds(setDoc(doc(db, 'results/e1/students/s1'), { score: 90 }));
    await assertSucceeds(updateDoc(doc(db, 'results/e1/students/s1'), { score: 95 }));
    await assertSucceeds(deleteDoc(doc(db, 'results/e1/students/s1')));
  });

  test('results/{examId} 부모 문서 write는 전면 거부 (students 서브컬렉션만 write)', async () => {
    await assertFails(setDoc(doc(teacher(), 'results/e1'), { meta: 'x' }));
    await assertFails(setDoc(doc(owner(), 'results/e1'), { meta: 'x' }));
  });

  test('teacher: results/students writeBatch set+delete (재배치 saveResult)', async () => {
    await seed('results/e1/students/legacy1', { score: 10 });
    const db = teacher();
    const batch = writeBatch(db);
    batch.set(doc(db, 'results/e1/students/s1'), { score: 88 });
    batch.delete(doc(db, 'results/e1/students/legacy1'));
    await assertSucceeds(batch.commit());
  });

  test('teacher: exams create/update/delete', async () => {
    const db = teacher();
    await assertSucceeds(setDoc(doc(db, 'exams/e1'), { title: '6월 모평' }));
    await assertSucceeds(updateDoc(doc(db, 'exams/e1'), { title: '7월 모평' }));
    await assertSucceeds(deleteDoc(doc(db, 'exams/e1')));
  });

  test('teacher: external_score_events + students write (내신 입력)', async () => {
    const db = teacher();
    await assertSucceeds(setDoc(doc(db, 'external_score_events/ev1'), { name: '1학기 중간' }));
    await assertSucceeds(setDoc(doc(db, 'external_score_events/ev1/students/s1'), { score: 100 }, { merge: true }));
    await assertSucceeds(updateDoc(doc(db, 'external_score_events/ev1'), { name: '1학기 기말' }));
    await assertSucceeds(deleteDoc(doc(db, 'external_score_events/ev1')));
  });

  test('teacher: exam_notifications create', async () => {
    const db = teacher();
    await assertSucceeds(setDoc(doc(db, 'exam_notifications/n1'), { message: '채점 완료' }));
  });

  test('teacher: exam_sets create/update/delete', async () => {
    const db = teacher();
    await assertSucceeds(setDoc(doc(db, 'exam_sets/set1'), { name: '수능인덱스' }));
    await assertSucceeds(updateDoc(doc(db, 'exam_sets/set1'), { name: '수능인덱스2' }));
    await assertSucceeds(deleteDoc(doc(db, 'exam_sets/set1')));
  });

  test('owner: departments/examTypes write + 채점 write (상위 포함)', async () => {
    const db = owner();
    await assertSucceeds(setDoc(doc(db, 'departments/d1'), { name: '고등부' }));
    await assertSucceeds(updateDoc(doc(db, 'departments/d1'), { name: '중등부' }));
    await assertSucceeds(deleteDoc(doc(db, 'departments/d1')));
    await assertSucceeds(setDoc(doc(db, 'examTypes/t1'), { name: '모의고사' }));
    await assertSucceeds(updateDoc(doc(db, 'examTypes/t1'), { name: '내신' }));
    await assertSucceeds(deleteDoc(doc(db, 'examTypes/t1')));
    await assertSucceeds(setDoc(doc(db, 'results/e1/students/s1'), { score: 70 }));
  });

  test('owner: isExamMember 경로(exams/외부성적/알림/수능인덱스)도 write 허용', async () => {
    const db = owner();
    await assertSucceeds(setDoc(doc(db, 'exams/e1'), { title: 'x' }));
    await assertSucceeds(setDoc(doc(db, 'external_score_events/ev1'), { name: 'x' }));
    await assertSucceeds(setDoc(doc(db, 'external_score_events/ev1/students/s1'), { score: 1 }));
    await assertSucceeds(setDoc(doc(db, 'exam_notifications/n1'), { message: 'x' }));
    await assertSucceeds(setDoc(doc(db, 'exam_sets/set1'), { name: 'x' }));
  });

  // ---- read는 isAuthorized 유지 (조이지 않았는지) ----

  test('exam_users 문서 없는 impact7 계정: read는 여전히 허용', async () => {
    await seed('exams/e1', { title: 'x' });
    await seed('results/e1/students/s1', { score: 1 });
    await seed('departments/d1', { name: 'x' });
    const db = noProfile();
    await assertSucceeds(getDoc(doc(db, 'exams/e1')));
    await assertSucceeds(getDoc(doc(db, 'results/e1/students/s1')));
    await assertSucceeds(getDoc(doc(db, 'departments/d1')));
  });

  // ---- 강화 목적: DENY ----

  test('teacher: departments write 거부 (owner 전용)', async () => {
    await seed('departments/d1', { name: '고등부' });
    const db = teacher();
    await assertFails(setDoc(doc(db, 'departments/d2'), { name: '신설' }));
    await assertFails(updateDoc(doc(db, 'departments/d1'), { name: '변경' }));
    await assertFails(deleteDoc(doc(db, 'departments/d1')));
  });

  test('teacher: examTypes write 거부 (owner 전용)', async () => {
    await seed('examTypes/t1', { name: '모의고사' });
    const db = teacher();
    await assertFails(setDoc(doc(db, 'examTypes/t2'), { name: '신설' }));
    await assertFails(updateDoc(doc(db, 'examTypes/t1'), { name: '변경' }));
    await assertFails(deleteDoc(doc(db, 'examTypes/t1')));
  });

  test('exam_templates client write 전면 거부 (admin only)', async () => {
    await assertFails(setDoc(doc(teacher(), 'exam_templates/tp1'), { a: 1 }));
    await assertFails(setDoc(doc(owner(), 'exam_templates/tp1'), { a: 1 }));
  });

  test('answer_keys client write 전면 거부 (admin only)', async () => {
    await seed('answer_keys/k1', { answers: [1] });
    await assertFails(setDoc(doc(teacher(), 'answer_keys/k2'), { answers: [2] }));
    await assertFails(updateDoc(doc(owner(), 'answer_keys/k1'), { answers: [3] }));
    await assertFails(deleteDoc(doc(owner(), 'answer_keys/k1')));
  });

  test('exam_users 문서 없는 impact7 계정: 전 컬렉션 write 거부', async () => {
    const db = noProfile();
    await assertFails(setDoc(doc(db, 'results/e1/students/s1'), { score: 0 }));
    await assertFails(setDoc(doc(db, 'exams/e1'), { title: 'x' }));
    await assertFails(setDoc(doc(db, 'departments/d1'), { name: 'x' }));
    await assertFails(setDoc(doc(db, 'examTypes/t1'), { name: 'x' }));
    await assertFails(setDoc(doc(db, 'external_score_events/ev1'), { name: 'x' }));
    await assertFails(setDoc(doc(db, 'external_score_events/ev1/students/s1'), { score: 0 }));
    await assertFails(setDoc(doc(db, 'exam_sets/set1'), { name: 'x' }));
    await assertFails(setDoc(doc(db, 'exam_notifications/n1'), { message: 'x' }));
  });

  test('exam_users 문서는 있으나 role 필드 없는 계정: write 거부', async () => {
    await seed('exam_users/norole1', { uid: 'norole1', email: 'norole1@impact7.kr', displayName: 'N One', deptIds: [] });
    const db = authedCtx(env, 'norole1');
    await assertFails(setDoc(doc(db, 'results/e1/students/s1'), { score: 0 }));
    await assertFails(setDoc(doc(db, 'exams/e1'), { title: 'x' }));
    await assertFails(setDoc(doc(db, 'departments/d1'), { name: 'x' }));
  });

  test('owner의 exam_users 관리: 유효 role만 create/update 허용, delete 허용', async () => {
    await seed('exam_users/u2', { uid: 'u2', email: 'u2@impact7.kr', displayName: 'U Two', role: 'teacher', deptIds: [] });
    const db = owner();
    await assertFails(setDoc(doc(db, 'exam_users/u3'), { uid: 'u3', email: 'u3@impact7.kr', displayName: 'U Three', deptIds: [] }));
    await assertFails(updateDoc(doc(db, 'exam_users/u2'), { role: 'admin' }));
    await assertSucceeds(setDoc(doc(db, 'exam_users/u3'), { uid: 'u3', email: 'u3@impact7.kr', displayName: 'U Three', role: 'teacher', deptIds: [] }));
    await assertSucceeds(updateDoc(doc(db, 'exam_users/u2'), { role: 'owner' }));
    await assertSucceeds(deleteDoc(doc(db, 'exam_users/u2')));
  });

  test('외부 도메인 계정: read/write 모두 거부 (현행 isAuthorized 유지)', async () => {
    await seed('exams/e1', { title: 'x' });
    const db = externalCtx(env);
    await assertFails(getDoc(doc(db, 'exams/e1')));
    await assertFails(setDoc(doc(db, 'exams/e2'), { title: 'y' }));
    await assertFails(setDoc(doc(db, 'results/e1/students/s1'), { score: 0 }));
  });

  test('비인증: read/write 거부', async () => {
    await seed('exams/e1', { title: 'x' });
    const db = unauthedCtx(env);
    await assertFails(getDoc(doc(db, 'exams/e1')));
    await assertFails(setDoc(doc(db, 'exams/e1'), { title: 'y' }));
  });
});
