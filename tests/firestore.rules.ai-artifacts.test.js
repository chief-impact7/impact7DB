import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx } from './firestore-rules-helpers.js';

describe('AI 산출물 컬렉션 (read-only for client)', () => {
  let env;
  before(async () => {
    env = await createTestEnv();
    await env.clearFirestore();
  });
  after(async () => { await env?.cleanup(); });

  const collections = ['consultation_summaries', 'consultation_briefings', 'consultation_trends'];

  for (const coll of collections) {
    test(`${coll}: 인증된 사용자 read 허용`, async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), `${coll}/id1`), { generated_at: serverTimestamp() });
      });
      const db = authedCtx(env, 'teacher1');
      await assertSucceeds(getDoc(doc(db, `${coll}/id1`)));
    });

    test(`${coll}: 비인증 read 거부`, async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), `${coll}/id1`), { generated_at: serverTimestamp() });
      });
      const db = unauthedCtx(env);
      await assertFails(getDoc(doc(db, `${coll}/id1`)));
    });

    test(`${coll}: 클라이언트 create/update/delete 모두 거부`, async () => {
      const db = authedCtx(env, 'teacher1');
      await assertFails(setDoc(doc(db, `${coll}/id1`), { foo: 'bar' }));
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), `${coll}/id1`), { foo: 'bar' });
      });
      await assertFails(deleteDoc(doc(db, `${coll}/id1`)));
    });
  }
});
