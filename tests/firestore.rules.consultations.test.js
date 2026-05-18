import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx } from './firestore-rules-helpers.js';

describe('consultations rules', () => {
  let env;
  before(async () => {
    env = await createTestEnv();
    await env.clearFirestore();
  });
  after(async () => { await env?.cleanup(); });

  const validData = (overrides = {}) => ({
    consultation_id: 'c1',
    student_id: '홍길동_1012345678',
    student_name: '홍길동',
    teacher_id: 'teacher1',
    teacher_name: '김선생',
    date: '2026-05-18',
    consultation_type: '정기',
    text: '메모',
    ai_processed: false,
    ai_processed_at: null,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    ...overrides,
  });

  test('비인증 사용자는 create 거부', async () => {
    const db = unauthedCtx(env);
    await assertFails(setDoc(doc(db, 'consultations/c1'), validData()));
  });

  test('인증된 강사가 본인 teacher_id로 create 허용', async () => {
    const db = authedCtx(env, 'teacher1');
    await assertSucceeds(setDoc(doc(db, 'consultations/c1'), validData()));
  });

  test('남의 teacher_id로 create 거부', async () => {
    const db = authedCtx(env, 'teacher1');
    await assertFails(setDoc(doc(db, 'consultations/c1'), validData({ teacher_id: 'teacher2' })));
  });

  test('인증된 사용자는 read 허용 (학원 내 공유)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'consultations/c1'), validData());
    });
    const db = authedCtx(env, 'teacher2');
    await assertSucceeds(getDoc(doc(db, 'consultations/c1')));
  });

  test('비인증 read 거부', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'consultations/c1'), validData());
    });
    const db = unauthedCtx(env);
    await assertFails(getDoc(doc(db, 'consultations/c1')));
  });

  test('본인 작성 24h 이내 update 허용 (ai_processed 제외)', async () => {
    const recent = Timestamp.fromDate(new Date(Date.now() - 60 * 60 * 1000)); // 1h ago
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'consultations/c1'), { ...validData(), created_at: recent });
    });
    const db = authedCtx(env, 'teacher1');
    await assertSucceeds(updateDoc(doc(db, 'consultations/c1'), { text: '수정' }));
  });

  test('24h 초과 update 거부', async () => {
    const old = Timestamp.fromDate(new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'consultations/c1'), { ...validData(), created_at: old });
    });
    const db = authedCtx(env, 'teacher1');
    await assertFails(updateDoc(doc(db, 'consultations/c1'), { text: '수정' }));
  });

  test('ai_processed 필드 변경 거부 (서버 전용)', async () => {
    const recent = Timestamp.fromDate(new Date(Date.now() - 60 * 60 * 1000));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'consultations/c1'), { ...validData(), created_at: recent });
    });
    const db = authedCtx(env, 'teacher1');
    await assertFails(updateDoc(doc(db, 'consultations/c1'), { ai_processed: true }));
  });

  test('delete는 항상 거부', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'consultations/c1'), validData());
    });
    const db = authedCtx(env, 'teacher1');
    await assertFails(deleteDoc(doc(db, 'consultations/c1')));
  });
});
