import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx, externalCtx } from './firestore-rules-helpers.js';

const TEACHER = { uid: 'u1', email: 'u1@impact7.kr', displayName: 'U One', role: 'teacher', deptIds: [] };

describe('exam_users — 권한 상승 / 외부 도메인 차단 (C-01, N-01)', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-exam-users'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => { await env.clearFirestore(); });

  async function seed(path, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), data);
    });
  }

  test('자기 문서 teacher 기본 self-create 허용 (exam 프로비저닝 보존)', async () => {
    const db = authedCtx(env, 'u1');
    await assertSucceeds(setDoc(doc(db, 'exam_users/u1'), TEACHER));
  });

  test('자기 문서 self-create에 role:owner 설정 거부 (escalation)', async () => {
    const db = authedCtx(env, 'u1');
    await assertFails(setDoc(doc(db, 'exam_users/u1'), { ...TEACHER, role: 'owner' }));
  });

  test('자기 displayName 변경 허용 (role 불변)', async () => {
    await seed('exam_users/u1', TEACHER);
    const db = authedCtx(env, 'u1');
    await assertSucceeds(updateDoc(doc(db, 'exam_users/u1'), { displayName: 'Renamed' }));
  });

  test('자기 role을 owner로 변경 거부 (escalation)', async () => {
    await seed('exam_users/u1', TEACHER);
    const db = authedCtx(env, 'u1');
    await assertFails(updateDoc(doc(db, 'exam_users/u1'), { role: 'owner' }));
  });

  test('일반 사용자가 타인 문서 변경 거부', async () => {
    await seed('exam_users/u2', { ...TEACHER, uid: 'u2', email: 'u2@impact7.kr' });
    const db = authedCtx(env, 'u1');
    await assertFails(updateDoc(doc(db, 'exam_users/u2'), { displayName: 'Hacked' }));
  });

  test('owner는 타인 role 변경 허용', async () => {
    await seed('exam_users/owner1', { uid: 'owner1', email: 'owner1@impact7.kr', displayName: 'Owner', role: 'owner', deptIds: [] });
    await seed('exam_users/u2', { ...TEACHER, uid: 'u2', email: 'u2@impact7.kr' });
    const db = authedCtx(env, 'owner1');
    await assertSucceeds(updateDoc(doc(db, 'exam_users/u2'), { role: 'owner' }));
  });

  test('외부 도메인 계정 read 거부 (N-01)', async () => {
    await seed('exam_users/u1', TEACHER);
    const db = externalCtx(env);
    await assertFails(getDoc(doc(db, 'exam_users/u1')));
  });

  test('외부 도메인 계정 자기 문서 write 거부 (N-01)', async () => {
    const db = externalCtx(env, 'ext1', 'attacker@gmail.com');
    await assertFails(setDoc(doc(db, 'exam_users/ext1'), { uid: 'ext1', email: 'attacker@gmail.com', displayName: 'X', role: 'teacher', deptIds: [] }));
  });

  test('impact7 도메인 계정 read 허용', async () => {
    await seed('exam_users/u1', TEACHER);
    const db = authedCtx(env, 'u1');
    await assertSucceeds(getDoc(doc(db, 'exam_users/u1')));
  });

  test('비인증 read/write 거부', async () => {
    await seed('exam_users/u1', TEACHER);
    const db = unauthedCtx(env);
    await assertFails(getDoc(doc(db, 'exam_users/u1')));
    await assertFails(setDoc(doc(db, 'exam_users/u1'), TEACHER));
  });
});
