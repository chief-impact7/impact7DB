import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, updateDoc } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx } from './firestore-rules-helpers.js';

function externalCtx(env, uid = 'ext1', email = 'attacker@gmail.com') {
  return env.authenticatedContext(uid, { email, email_verified: true }).firestore();
}

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

  test('impact7 계정 createdBy=self create 허용', async () => {
    const db = authedCtx(env, 'u1');
    await assertSucceeds(setDoc(doc(db, 'exam_analyses/a1'), { createdBy: 'u1', title: 'A' }));
  });

  test('외부 도메인 계정 create 거부 (N-01)', async () => {
    const db = externalCtx(env, 'ext1', 'attacker@gmail.com');
    await assertFails(setDoc(doc(db, 'exam_analyses/a1'), { createdBy: 'ext1', title: 'A' }));
  });

  test('createdBy != 본인 create 거부', async () => {
    const db = authedCtx(env, 'u1');
    await assertFails(setDoc(doc(db, 'exam_analyses/a1'), { createdBy: 'someone-else', title: 'A' }));
  });

  test('작성자 update 허용 / 타인 update 거부', async () => {
    await seed('exam_analyses/a1', { createdBy: 'u1', title: 'A' });
    const owner = authedCtx(env, 'u1');
    await assertSucceeds(updateDoc(doc(owner, 'exam_analyses/a1'), { title: 'B' }));
    const other = authedCtx(env, 'u2');
    await assertFails(updateDoc(doc(other, 'exam_analyses/a1'), { title: 'C' }));
  });

  test('비인증 read 거부', async () => {
    await seed('exam_analyses/a1', { createdBy: 'u1', title: 'A' });
    const db = unauthedCtx(env);
    await assertFails(getDoc(doc(db, 'exam_analyses/a1')));
  });
});
