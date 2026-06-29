import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc } from 'firebase/firestore';
import { createTestEnv, authedCtx, unauthedCtx } from './firestore-rules-helpers.js';

describe('staff 통합 규칙 — department 필드 포함', () => {
  let env;
  before(async () => {
    env = await createTestEnv('rules-test-personnel');
    await env.clearFirestore();
  });
  after(async () => { await env?.cleanup(); });

  // director 컨텍스트 생성: HR_users/{uid}에 role='principal' 설정
  async function setupDirector(uid = 'director1') {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `HR_users/${uid}`), {
        role: 'principal',
      });
    });
    return authedCtx(env, uid);
  }

  // 일반 staff 컨텍스트 (role='staff')
  async function setupStaff(uid = 'staff1') {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `HR_users/${uid}`), {
        role: 'staff',
      });
    });
    return authedCtx(env, uid);
  }

  test('director가 staff/{id}에 department="행정" 포함 문서 쓰기 → 성공', async () => {
    const directorDb = await setupDirector('director1');
    await assertSucceeds(setDoc(doc(directorDb, 'staff/s1'), {
      name: '관리자',
      email: 'admin@school.kr',
      department: '행정',
    }));
  });

  test('director가 staff/{id}에 department="교수" 포함 문서 쓰기 → 성공', async () => {
    const directorDb = await setupDirector('director2');
    await assertSucceeds(setDoc(doc(directorDb, 'staff/s2'), {
      name: '교수자',
      email: 'prof@school.kr',
      department: '교수',
    }));
  });

  test('director가 staff/{id}에 department="단기" 포함 문서 쓰기 → 성공', async () => {
    const directorDb = await setupDirector('director3');
    await assertSucceeds(setDoc(doc(directorDb, 'staff/s3'), {
      name: '계약강사',
      email: 'contract@school.kr',
      department: '단기',
    }));
  });

  test('director가 staff/{id}에 department 미포함 문서 쓰기 → 성공 (부분 필드)', async () => {
    const directorDb = await setupDirector('director4');
    await assertSucceeds(setDoc(doc(directorDb, 'staff/s4'), {
      name: '일반직원',
      email: 'staff@school.kr',
    }));
  });

  test('비-director(staff)가 staff/{id} 쓰기 → 실패', async () => {
    const staffDb = await setupStaff('staff1');
    await assertFails(setDoc(doc(staffDb, 'staff/s5'), {
      name: '직원',
      email: 'emp@school.kr',
      department: '교무',
    }));
  });

  test('로그인 사용자가 staff/{id} read → 성공', async () => {
    const directorDb = await setupDirector('director5');
    // 규칙 우회해서 문서 생성
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'staff/s6'), {
        name: '테스트직원',
        department: '교무',
      });
    });
    // 로그인 사용자로 read 시도
    await assertSucceeds(getDoc(doc(directorDb, 'staff/s6')));
  });

  test('비인증 사용자 staff/{id} read → 실패', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'staff/s7'), {
        name: '테스트',
        department: '교무',
      });
    });
    const unauthDb = unauthedCtx(env);
    await assertFails(getDoc(doc(unauthDb, 'staff/s7')));
  });

  test('온보딩: 유효한 토큰으로 비인증 staff create(status=onboarding) → 성공(회귀)', async () => {
    const tokenId = 'valid-token-123';
    // 온보딩 토큰 생성
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `onboardingTokens/${tokenId}`), {
        status: 'pending',
        expiresAt: new Date(Date.now() + 86400000), // 24시간 후
      });
    });
    const unauthDb = unauthedCtx(env);
    // 온보딩 staff create 시도 (필드는 hasOnly 제약)
    await assertSucceeds(setDoc(doc(unauthDb, 'staff/onboard1'), {
      name: '신입직원',
      phone: '01012345678',
      email: 'newstaff@school.kr',
      residentNumber: '950101-1234567',
      birthDate: '1995-01-01',
      address: '서울시',
      subject: '수학',
      bankInfo: { bank: '국민' },
      taxInfo: { type: '기타' },
      documents: [],
      staffType: '정규직',
      status: 'onboarding',
      joinDate: '2025-01-01',
      tokenId,
    }));
  });
});
