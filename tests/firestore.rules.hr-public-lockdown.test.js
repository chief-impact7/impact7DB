import { test, before, after, beforeEach, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, getDocs, collection, updateDoc } from 'firebase/firestore';
import { createTestEnv, unauthedCtx, authedCtx } from './firestore-rules-helpers.js';

// G03: 공개 토큰 read·직원/계약 get을 제거(getHrPublicToken callable로 이전)했음을 검증.
// 동시에 비인증 write 완료 경로(온보딩/서명 update)는 유지되어야 한다(HR 제출 플로우 보존).
const future = () => new Date(Date.now() + 24 * 3600 * 1000);

describe('HR 공개 read/get 차단 + write 경로 유지 (C-02/C-03/N-02 = G03)', () => {
  let env;
  before(async () => { env = await createTestEnv('rules-test-hr-lockdown'); });
  after(async () => { await env?.cleanup(); });
  beforeEach(async () => { await env.clearFirestore(); });

  async function seed(path, data) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), path), data);
    });
  }

  const TOKEN_COLLECTIONS = [
    'onboardingTokens', 'contractSigningTokens', 'salaryAgreementTokens',
    'shortTermTokens', 'employeeOnboardingTokens', 'employeeContractSigningTokens',
  ];

  for (const coll of TOKEN_COLLECTIONS) {
    test(`${coll}: 비인증 get 거부 (공개 read 제거)`, async () => {
      await seed(`${coll}/t1`, { status: 'pending', expiresAt: future() });
      const db = unauthedCtx(env);
      await assertFails(getDoc(doc(db, `${coll}/t1`)));
    });
    test(`${coll}: 비인증 list(열거) 거부`, async () => {
      await seed(`${coll}/t1`, { status: 'pending', expiresAt: future() });
      const db = unauthedCtx(env);
      await assertFails(getDocs(collection(db, coll)));
    });
  }

  test('staff 비인증 get 거부 (공개 get 제거)', async () => {
    await seed('staff/s1', { name: '김강사', residentNumber: '900101-1234567' });
    await assertFails(getDoc(doc(unauthedCtx(env), 'staff/s1')));
  });

  test('보드 안전 명부는 조직 계정만 읽고 클라이언트 쓰기는 거부한다', async () => {
    await seed('staff_directory/s1', { display_name: '김교수', email: 'kim@impact7.kr', department: '교수', assignable: true });
    await assertFails(getDoc(doc(unauthedCtx(env), 'staff_directory/s1')));
    const db = authedCtx(env, 'staff-directory-reader');
    await assertSucceeds(getDoc(doc(db, 'staff_directory/s1')));
    await assertFails(updateDoc(doc(db, 'staff_directory/s1'), { assignable: false }));
  });

  test('staff contract 비인증 get 거부', async () => {
    await seed('staff/s1/contracts/c1', { status: 'ready' });
    await assertFails(getDoc(doc(unauthedCtx(env), 'staff/s1/contracts/c1')));
  });

  test('employees 비인증 get 거부', async () => {
    await seed('employees/em1', { name: '이직원', residentNumber: '950505-2345678' });
    await assertFails(getDoc(doc(unauthedCtx(env), 'employees/em1')));
  });

  test('employee contract 비인증 get 거부', async () => {
    await seed('employees/em1/contracts/c9', { status: 'ready' });
    await assertFails(getDoc(doc(unauthedCtx(env), 'employees/em1/contracts/c9')));
  });

  // write 경로 유지 — 비인증 토큰 완료 update는 여전히 허용되어야 HR 제출이 동작.
  test('비인증 온보딩 토큰 완료 update는 유지 (pending→completed)', async () => {
    await seed('onboardingTokens/t1', { status: 'pending', expiresAt: future() });
    const db = unauthedCtx(env);
    await assertSucceeds(updateDoc(doc(db, 'onboardingTokens/t1'), { status: 'completed', staffId: 's1' }));
  });

  test('비인증 토큰 read는 막혀도 완료 update 자체는 막히지 않음 (만료 토큰은 거부)', async () => {
    await seed('onboardingTokens/t2', { status: 'pending', expiresAt: new Date(Date.now() - 1000) });
    const db = unauthedCtx(env);
    await assertFails(updateDoc(doc(db, 'onboardingTokens/t2'), { status: 'completed', staffId: 's1' }));
  });

  // H-1: 임의 Google 계정(비 impact7 도메인)은 로그인해도 조직 데이터 read·감사로그 create 불가.
  // 단기직원(외부 도메인 + HR_users role=shortterm)은 계속 허용.
  const outsider = () => authedCtx(env, 'evil1', 'attacker@gmail.com');

  test('비도메인 계정: entities/contractTemplates read 거부 (H-1)', async () => {
    await seed('entities/e1', { bizNumber: '123-45-67890' });
    await seed('contractTemplates/ct1', { body: '계약 조항' });
    await assertFails(getDoc(doc(outsider(), 'entities/e1')));
    await assertFails(getDoc(doc(outsider(), 'contractTemplates/ct1')));
  });

  test('비도메인 계정: auditLog create 거부 (허위 감사기록 주입 차단, H-1)', async () => {
    await assertFails(setDoc(doc(outsider(), 'auditLog/forged1'), { action: 'fake', at: new Date() }));
  });

  test('도메인 직원: entities read·auditLog create 허용 유지', async () => {
    await seed('entities/e1', { bizNumber: '123-45-67890' });
    const db = authedCtx(env, 'staff1');
    await assertSucceeds(getDoc(doc(db, 'entities/e1')));
    await assertSucceeds(setDoc(doc(db, 'auditLog/a1'), { action: 'login', at: new Date() }));
  });

  test('단기직원(외부 도메인 + role=shortterm): contractTemplates read 허용 유지', async () => {
    await seed('HR_users/short1', { role: 'shortterm' });
    await seed('contractTemplates/ct1', { body: '계약 조항' });
    const db = authedCtx(env, 'short1', 'worker@gmail.com');
    await assertSucceeds(getDoc(doc(db, 'contractTemplates/ct1')));
  });
});
