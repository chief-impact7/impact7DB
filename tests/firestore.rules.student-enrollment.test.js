import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, updateDoc } from 'firebase/firestore';
import { createTestEnv, authedCtx } from './firestore-rules-helpers.js';

// enrollmentStatusConsistent: 비재원 상태(퇴원/종강/상담)는 enrollments가 비어 있어야 한다.
// 일괄 퇴원/상태변경(applyBulkStatus·confirmBulkDelete)이 enrollments를 비우지 않으면
// 이 규칙이 batch 전체를 거부한다 → 클라는 reconcileEnrollments로 비워야 한다(M-05).
const ENROLL = [{ class_number: '101', level_symbol: 'HA' }];
const base = { name: '홍길동', enrollments: ENROLL, status: '재원', parent_phone_1: '010-1111-2222', branch: '본원' };

describe('students enrollment↔status 정합성 규칙 (M-05)', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-student-enroll'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => { await env.clearFirestore(); });

  async function seed(id, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `students/${id}`), data);
    });
  }

  test('퇴원 전환 + enrollments 잔존 → 거부 (현 일괄퇴원 버그 조건)', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertFails(updateDoc(doc(db, 'students/s1'), { status: '퇴원' }));
  });

  test('퇴원 전환 + enrollments 비움 → 허용 (reconcile 결과)', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertSucceeds(updateDoc(doc(db, 'students/s1'), { status: '퇴원', enrollments: [] }));
  });

  test('재원 유지 + enrollments 잔존 → 허용', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertSucceeds(updateDoc(doc(db, 'students/s1'), { status: '재원', enrollments: ENROLL }));
  });

  test('상담 전환 + enrollments 잔존 → 거부', async () => {
    await seed('s1', base);
    const db = authedCtx(env, 't1');
    await assertFails(updateDoc(doc(db, 'students/s1'), { status: '상담' }));
  });

  test('생성: 종강 + enrollments 비움 → 허용', async () => {
    const db = authedCtx(env, 't1');
    await assertSucceeds(setDoc(doc(db, 'students/s2'), { name: '김학생', enrollments: [], status: '종강' }));
  });
});
