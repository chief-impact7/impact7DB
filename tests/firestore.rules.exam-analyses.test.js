import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx, externalCtx } from './firestore-rules-helpers.js';

describe('exam_analyses — 외부 도메인 read/create 차단 (N-01)', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-exam-analyses'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => { await env.clearFirestore(); });

  async function seed(path, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), data);
    });
  }

  // write는 exam_users 멤버(teacher/owner)만 — 테스트 uid를 멤버로 시딩
  async function seedMember(uid) {
    await seed(`exam_users/${uid}`, { uid, email: `${uid}@impact7.kr`, displayName: uid, role: 'teacher', deptIds: [] });
  }

  test('impact7 도메인 계정 read 허용', async () => {
    await seed('exam_analyses/a1', { createdBy: 'u1', title: 'A' });
    const db = authedCtx(env, 'u1');
    await assertSucceeds(getDoc(doc(db, 'exam_analyses/a1')));
  });

  test('외부 도메인 계정 read 거부 (N-01)', async () => {
    await seed('exam_analyses/a1', { createdBy: 'u1', title: 'A' });
    const db = externalCtx(env);
    await assertFails(getDoc(doc(db, 'exam_analyses/a1')));
  });

  test('exam 멤버 createdBy=self create 허용', async () => {
    await seedMember('u1');
    const db = authedCtx(env, 'u1');
    await assertSucceeds(setDoc(doc(db, 'exam_analyses/a1'), { createdBy: 'u1', title: 'A' }));
  });

  test('exam_users 문서 없는 impact7 계정 create 거부 (역할 강화)', async () => {
    const db = authedCtx(env, 'u9');
    await assertFails(setDoc(doc(db, 'exam_analyses/a1'), { createdBy: 'u9', title: 'A' }));
  });

  test('외부 도메인 계정 create 거부 (N-01)', async () => {
    const db = externalCtx(env, 'ext1', 'attacker@gmail.com');
    await assertFails(setDoc(doc(db, 'exam_analyses/a1'), { createdBy: 'ext1', title: 'A' }));
  });

  test('createdBy != 본인 create 거부', async () => {
    await seedMember('u1');
    const db = authedCtx(env, 'u1');
    await assertFails(setDoc(doc(db, 'exam_analyses/a1'), { createdBy: 'someone-else', title: 'A' }));
  });

  test('작성자 update 허용 / 타인 update 거부', async () => {
    await seedMember('u1');
    await seedMember('u2');
    await seed('exam_analyses/a1', { createdBy: 'u1', title: 'A' });
    const owner = authedCtx(env, 'u1');
    await assertSucceeds(updateDoc(doc(owner, 'exam_analyses/a1'), { title: 'B' }));
    const other = authedCtx(env, 'u2');
    await assertFails(updateDoc(doc(other, 'exam_analyses/a1'), { title: 'C' }));
  });

  test('owner는 타인 분석자료 update/delete 허용 (모더레이션)', async () => {
    await seedMember('u1');
    await seed('exam_users/own1', { uid: 'own1', email: 'own1@impact7.kr', displayName: 'own1', role: 'owner', deptIds: [] });
    await seed('exam_analyses/a1', { createdBy: 'u1', title: 'A' });
    const db = authedCtx(env, 'own1');
    await assertSucceeds(updateDoc(doc(db, 'exam_analyses/a1'), { title: 'MOD' }));
    await assertSucceeds(deleteDoc(doc(db, 'exam_analyses/a1')));
  });

  test('비인증 read 거부', async () => {
    await seed('exam_analyses/a1', { createdBy: 'u1', title: 'A' });
    const db = unauthedCtx(env);
    await assertFails(getDoc(doc(db, 'exam_analyses/a1')));
  });
});
