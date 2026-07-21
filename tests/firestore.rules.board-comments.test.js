import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, updateDoc, doc, getDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx } from './firestore-rules-helpers.js';

describe('board_cards/{cardId}/comments — 카드 댓글 서브컬렉션', () => {
  let env;
  before(async () => {
    env = await createTestEnv('impact7db-rules-test-board-comments');
    await env.clearFirestore();
  });
  after(async () => { await env?.cleanup(); });

  const PATH = 'board_cards/card1/comments/c1';
  const validComment = (by = 'teacher1@impact7.kr') => ({
    text: '확인했습니다',
    created_by: by,
    created_at: serverTimestamp(),
    updated_by: by,
    updated_at: serverTimestamp(),
  });

  test('인증된 사용자 read 허용', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), PATH), validComment());
    });
    await assertSucceeds(getDoc(doc(authedCtx(env, 'teacher1'), PATH)));
  });

  test('비인증 read/create 거부', async () => {
    const db = unauthedCtx(env);
    await assertFails(getDoc(doc(db, PATH)));
    await assertFails(setDoc(doc(db, 'board_cards/card1/comments/c2'), validComment()));
  });

  test('인증된 사용자 create 허용 (허용 필드만)', async () => {
    const db = authedCtx(env, 'teacher1');
    await assertSucceeds(setDoc(doc(db, 'board_cards/card1/comments/c3'), validComment()));
  });

  test('허용 목록 밖 필드 포함 create 거부', async () => {
    const db = authedCtx(env, 'teacher1');
    await assertFails(setDoc(doc(db, 'board_cards/card1/comments/c4'), { ...validComment(), evil: true }));
  });

  test('빈 text create 거부', async () => {
    const db = authedCtx(env, 'teacher1');
    await assertFails(setDoc(doc(db, 'board_cards/card1/comments/c5'), { ...validComment(), text: '' }));
  });

  test('update 거부 (수정 개념 없음)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), PATH), validComment());
    });
    await assertFails(updateDoc(doc(authedCtx(env, 'teacher1'), PATH), { text: '수정' }));
  });

  test('타인 댓글 delete 허용 — 카드 삭제 시 writeBatch 일괄 정리용(신뢰 직원 전제)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), PATH), validComment('teacher1@impact7.kr'));
    });
    await assertSucceeds(deleteDoc(doc(authedCtx(env, 'teacher2'), PATH)));
  });
});
