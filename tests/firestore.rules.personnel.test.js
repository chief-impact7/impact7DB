import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, updateDoc } from 'firebase/firestore';
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

describe('staff 통합 온보딩(3토큰)·계약서명(다토큰) 규칙 (Task 6d-2)', () => {
  let env;
  before(async () => {
    env = await createTestEnv('rules-test-personnel-unify');
    await env.clearFirestore();
  });
  after(async () => { await env?.cleanup(); });

  const FUTURE = () => new Date(Date.now() + 86400000); // 24h 후
  const PAST = () => new Date(Date.now() - 86400000); // 24h 전

  // 규칙 우회로 온보딩 토큰 문서 시드. opts로 status/expiresAt 조정.
  async function seedToken(collection, tokenId, opts = {}) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${collection}/${tokenId}`), {
        status: opts.status ?? 'pending',
        expiresAt: opts.expiresAt ?? FUTURE(),
        ...(opts.extra ?? {}),
      });
    });
  }

  // ── 긍정: 3종 온보딩 토큰으로 staff create ──────────────────────────────
  test('교사 온보딩: onboardingTokens 유효 + 교사필드 + department="교수" → 성공', async () => {
    await seedToken('onboardingTokens', 'tok-teacher');
    const db = unauthedCtx(env);
    await assertSucceeds(setDoc(doc(db, 'staff/u-teacher'), {
      name: '신규교사', phone: '01011112222', email: 't@school.kr',
      residentNumber: '900101-1234567', birthDate: '1990-01-01', address: '서울',
      subject: '영어', staffType: '정규직', department: '교수',
      status: 'onboarding', tokenId: 'tok-teacher',
    }));
  });

  test('행정 온보딩: employeeOnboardingTokens 유효 + position + department="행정" → 성공', async () => {
    await seedToken('employeeOnboardingTokens', 'tok-emp');
    const db = unauthedCtx(env);
    await assertSucceeds(setDoc(doc(db, 'staff/u-emp'), {
      name: '신규행정', phone: '01033334444', email: 'e@school.kr',
      residentNumber: '910202-2345678', birthDate: '1991-02-02', address: '서울',
      position: '행정실장', department: '행정',
      status: 'onboarding', tokenId: 'tok-emp',
    }));
  });

  test('단기 온보딩: shortTermTokens 유효 + 최소필드 + department="단기" → 성공', async () => {
    await seedToken('shortTermTokens', 'tok-short');
    const db = unauthedCtx(env);
    await assertSucceeds(setDoc(doc(db, 'staff/u-short'), {
      name: '단기강사', phone: '01055556666', email: 's@school.kr',
      department: '단기', status: 'onboarding', tokenId: 'tok-short',
    }));
  });

  // ── 보안 부정: 온보딩 create ───────────────────────────────────────────
  test('보안: 존재하지 않는 토큰(비인증) → 거부', async () => {
    const db = unauthedCtx(env);
    await assertFails(setDoc(doc(db, 'staff/neg-notoken'), {
      name: '침입자', status: 'onboarding', tokenId: 'does-not-exist',
    }));
  });

  test('보안: 만료된 토큰 → 거부', async () => {
    await seedToken('onboardingTokens', 'tok-expired', { expiresAt: PAST() });
    const db = unauthedCtx(env);
    await assertFails(setDoc(doc(db, 'staff/neg-expired'), {
      name: '만료', status: 'onboarding', tokenId: 'tok-expired',
    }));
  });

  test('보안: status!=pending(completed) 토큰 → 거부', async () => {
    await seedToken('employeeOnboardingTokens', 'tok-used', { status: 'completed' });
    const db = unauthedCtx(env);
    await assertFails(setDoc(doc(db, 'staff/neg-used'), {
      name: '재사용', status: 'onboarding', tokenId: 'tok-used',
    }));
  });

  test('보안: hasOnly 밖 권한 필드(role) 주입 → 거부', async () => {
    await seedToken('onboardingTokens', 'tok-inject');
    const db = unauthedCtx(env);
    await assertFails(setDoc(doc(db, 'staff/neg-inject'), {
      name: '권한탈취', department: '교수',
      status: 'onboarding', tokenId: 'tok-inject',
      role: 'admin', // hasOnly 밖 → 거부돼야 함
    }));
  });

  test('보안: status!="onboarding"(active) 비인증 create → 거부', async () => {
    await seedToken('onboardingTokens', 'tok-active');
    const db = unauthedCtx(env);
    await assertFails(setDoc(doc(db, 'staff/neg-active'), {
      name: '직행', department: '교수',
      status: 'active', tokenId: 'tok-active', // onboarding 아님 → 거부
    }));
  });

  // ── 계약 서명: staff/{id}/contracts 다토큰 ─────────────────────────────
  // ready 상태 계약 + 토큰 시드
  async function seedContract(staffId, contractId) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `staff/${staffId}`), {
        name: '행정직원', department: '행정',
      });
      await setDoc(doc(ctx.firestore(), `staff/${staffId}/contracts/${contractId}`), {
        status: 'ready', assignedTo: 'someuid', contractType: '4대보험',
      });
    });
  }

  test('계약 서명: 유효 employeeContractSigningTokens → staff contract ready→signed 성공', async () => {
    await seedContract('sig-ok', 'c1');
    await seedToken('employeeContractSigningTokens', 'sigtok-ok', { extra: { contractId: 'c1' } });
    const db = unauthedCtx(env);
    await assertSucceeds(updateDoc(doc(db, 'staff/sig-ok/contracts/c1'), {
      status: 'signed',
      signatures: { employee: { signatureUrl: 'https://sig/e.png' } },
      signingTokenId: 'sigtok-ok',
      updatedAt: new Date(),
    }));
  });

  test('보안: 계약 서명 잘못된 토큰(contractId 불일치) → 거부', async () => {
    await seedContract('sig-bad', 'c1');
    await seedToken('employeeContractSigningTokens', 'sigtok-bad', { extra: { contractId: 'OTHER' } });
    const db = unauthedCtx(env);
    await assertFails(updateDoc(doc(db, 'staff/sig-bad/contracts/c1'), {
      status: 'signed',
      signatures: { employee: { signatureUrl: 'https://sig/e.png' } },
      signingTokenId: 'sigtok-bad',
      updatedAt: new Date(),
    }));
  });

  test('보안: 계약 서명 존재하지 않는 토큰 → 거부', async () => {
    await seedContract('sig-none', 'c1');
    const db = unauthedCtx(env);
    await assertFails(updateDoc(doc(db, 'staff/sig-none/contracts/c1'), {
      status: 'signed',
      signatures: { employee: { signatureUrl: 'https://sig/e.png' } },
      signingTokenId: 'no-such-token',
      updatedAt: new Date(),
    }));
  });
});
