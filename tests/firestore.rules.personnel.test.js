import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { setDoc, doc, getDoc, updateDoc, getDocs, collection, query, where } from 'firebase/firestore';
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

  test('교사 온보딩: phoneKey·englishName 포함(키오스크 매칭/표시) → 성공', async () => {
    await seedToken('onboardingTokens', 'tok-kiosk');
    const db = unauthedCtx(env);
    await assertSucceeds(setDoc(doc(db, 'staff/u-kiosk'), {
      name: '키오스크교사', phone: '01077778888', email: 'k@school.kr',
      residentNumber: '920303-1234567', birthDate: '1992-03-03', address: '서울',
      subject: '수학', staffType: '정규직', department: '교수',
      phoneKey: '017777', englishName: 'Kiosk Teacher',
      status: 'onboarding', tokenId: 'tok-kiosk',
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

  // 익명 서명 write는 e93f290에서 서버 callable 전용으로 이관 — 유효 토큰이어도
  // 클라 직접 update는 항상 거부되어야 한다(익명 update 규칙 부활 방지 가드).
  test('계약 서명: 유효 토큰이어도 익명 직접 write 거부 (callable 전용)', async () => {
    await seedContract('sig-ok', 'c1');
    await seedToken('employeeContractSigningTokens', 'sigtok-ok', { extra: { contractId: 'c1' } });
    const db = unauthedCtx(env);
    await assertFails(updateDoc(doc(db, 'staff/sig-ok/contracts/c1'), {
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

describe('staff read PII 제한 — director+manager 전체, shortterm은 단기만 (Task rules45 #5)', () => {
  let env;
  before(async () => {
    env = await createTestEnv('rules-test-personnel-readpii');
    await env.clearFirestore();
  });
  after(async () => { await env?.cleanup(); });

  // HR_users/{uid}.role 시드 후 인증 컨텍스트 반환.
  async function ctxWithRole(uid, role) {
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), `HR_users/${uid}`), { role });
    });
    return authedCtx(env, uid);
  }

  // 규칙 우회로 staff 문서 시드(부서별).
  async function seedStaff(id, department) {
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), `staff/${id}`), {
        name: `직원-${id}`, department,
        residentNumber: '900101-1234567', // PII
      });
    });
  }

  before(async () => {
    await seedStaff('prof1', '교수');
    await seedStaff('admin1', '행정');
    await seedStaff('short1', '단기');
    await seedStaff('short2', '단기');
  });

  test('director(principal): 교수 문서 read → 성공', async () => {
    const db = await ctxWithRole('dir1', 'principal');
    await assertSucceeds(getDoc(doc(db, 'staff/prof1')));
  });

  test('director(owner): 행정 문서 read → 성공', async () => {
    const db = await ctxWithRole('dir2', 'owner');
    await assertSucceeds(getDoc(doc(db, 'staff/admin1')));
  });

  test('manager: 교수 문서 read → 성공(전체 열람)', async () => {
    const db = await ctxWithRole('mgr1', 'manager');
    await assertSucceeds(getDoc(doc(db, 'staff/prof1')));
  });

  test('manager: 단기 문서 read → 성공', async () => {
    const db = await ctxWithRole('mgr2', 'manager');
    await assertSucceeds(getDoc(doc(db, 'staff/short1')));
  });

  // shortterm의 단기 PII read는 9f6d40e(H-1 예방)에서 제거 — 역할 재도입 시
  // 본인 문서 스코프(ownerUid)로 재설계 예정. 그 전까지는 거부가 정답.
  test('shortterm: 단기 부서 문서 read → 거부(H-1 PII 제거)', async () => {
    const db = await ctxWithRole('st1', 'shortterm');
    await assertFails(getDoc(doc(db, 'staff/short1')));
  });

  test('shortterm: 교수 문서 read → 거부(PII 차단)', async () => {
    const db = await ctxWithRole('st2', 'shortterm');
    await assertFails(getDoc(doc(db, 'staff/prof1')));
  });

  test('shortterm: 행정 문서 read → 거부(PII 차단)', async () => {
    const db = await ctxWithRole('st3', 'shortterm');
    await assertFails(getDoc(doc(db, 'staff/admin1')));
  });

  test('staff: 어떤 staff 문서도 read → 거부', async () => {
    const db = await ctxWithRole('stf1', 'staff');
    await assertFails(getDoc(doc(db, 'staff/short1')));
    await assertFails(getDoc(doc(db, 'staff/prof1')));
  });

  test('teacher: staff 문서 read → 거부', async () => {
    const db = await ctxWithRole('tch1', 'teacher');
    await assertFails(getDoc(doc(db, 'staff/short1')));
  });

  // ── LIST 쿼리 규칙 평가 ──────────────────────────────────────────────
  test('shortterm LIST: where(department==단기) 쿼리 → 거부(H-1 PII 제거)', async () => {
    const db = await ctxWithRole('st-list-ok', 'shortterm');
    await assertFails(getDocs(query(collection(db, 'staff'), where('department', '==', '단기'))));
  });

  test('shortterm LIST: 무제약 staff 열거 → 거부(전 직원 PII 노출 차단)', async () => {
    const db = await ctxWithRole('st-list-bad', 'shortterm');
    await assertFails(getDocs(collection(db, 'staff')));
  });

  test('shortterm LIST: where(department==교수) 쿼리 → 거부', async () => {
    const db = await ctxWithRole('st-list-prof', 'shortterm');
    await assertFails(getDocs(query(collection(db, 'staff'), where('department', '==', '교수'))));
  });

  test('manager LIST: 무제약 staff 열거 → 성공(전체 열람)', async () => {
    const db = await ctxWithRole('mgr-list', 'manager');
    await assertSucceeds(getDocs(collection(db, 'staff')));
  });

  // ── 레거시 컬렉션 우회 차단(employees·shortTermStaff) ─────────────────
  // staff 잠금을 우회해 동일 PII를 읽던 레거시 경로를 함께 닫았는지 검증.
  test('legacy employees: staff 역할 read → 거부(우회 차단)', async () => {
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), 'employees/e1'), {
        name: '레거시직원', residentNumber: '900101-1234567', bankInfo: { accountNumber: '123' },
      });
    });
    const staffDb = await ctxWithRole('legacy-staff', 'staff');
    await assertFails(getDoc(doc(staffDb, 'employees/e1')));
    await assertFails(getDocs(collection(staffDb, 'employees')));
  });

  test('legacy employees: manager read → 성공', async () => {
    const db = await ctxWithRole('legacy-mgr', 'manager');
    await assertSucceeds(getDoc(doc(db, 'employees/e1')));
  });

  test('legacy shortTermStaff: teacher 역할 read → 거부', async () => {
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), 'shortTermStaff/st-legacy'), {
        name: '레거시단기', residentNumber: '950505-2345678',
      });
    });
    const tchDb = await ctxWithRole('legacy-tch', 'teacher');
    await assertFails(getDoc(doc(tchDb, 'shortTermStaff/st-legacy')));
  });
});

describe('staff write 권한 — director+manager 허용 (근태현황 빠른입력)', () => {
  let env;
  before(async () => {
    env = await createTestEnv('rules-test-personnel-write');
    await env.clearFirestore();
  });
  after(async () => { await env?.cleanup(); });

  // HR_users/{uid}.role 시드 후 인증 컨텍스트 반환.
  async function ctxWithRole(uid, role) {
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), `HR_users/${uid}`), { role });
    });
    return authedCtx(env, uid);
  }

  test('director: staff create(근태기록) → 성공', async () => {
    const db = await ctxWithRole('dir-write1', 'principal');
    await assertSucceeds(setDoc(doc(db, 'staff/direct-create'), {
      name: '관리자-생성',
      email: 'admin-new@school.kr',
      department: '행정',
    }));
  });

  test('director: staff update(근태기록) → 성공', async () => {
    // 규칙 우회로 문서 생성
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), 'staff/dir-update-target'), {
        name: '관리자-수정대상',
        department: '행정',
      });
    });
    const db = await ctxWithRole('dir-write2', 'principal');
    await assertSucceeds(updateDoc(doc(db, 'staff/dir-update-target'), {
      name: '관리자-수정됨',
    }));
  });

  test('manager: staff create(근태기록) → 성공', async () => {
    const db = await ctxWithRole('mgr-write1', 'manager');
    await assertSucceeds(setDoc(doc(db, 'staff/mgr-create'), {
      name: '매니저-생성',
      email: 'mgr-new@school.kr',
      department: '교무',
    }));
  });

  test('manager: staff update(근태기록) → 성공', async () => {
    // 규칙 우회로 문서 생성
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), 'staff/mgr-update-target'), {
        name: '매니저-수정대상',
        department: '교무',
      });
    });
    const db = await ctxWithRole('mgr-write2', 'manager');
    await assertSucceeds(updateDoc(doc(db, 'staff/mgr-update-target'), {
      name: '매니저-수정됨',
    }));
  });

  test('staff: staff create → 거부', async () => {
    const db = await ctxWithRole('stf-write1', 'staff');
    await assertFails(setDoc(doc(db, 'staff/stf-create-fail'), {
      name: '직원-거부',
      email: 'staff-fail@school.kr',
    }));
  });

  test('staff: staff update → 거부', async () => {
    // 규칙 우회로 문서 생성
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), 'staff/stf-update-fail'), {
        name: '직원-수정불가',
        department: '행정',
      });
    });
    const db = await ctxWithRole('stf-write2', 'staff');
    await assertFails(updateDoc(doc(db, 'staff/stf-update-fail'), {
      name: '수정시도',
    }));
  });

  test('teacher: staff create → 거부', async () => {
    const db = await ctxWithRole('tch-write1', 'teacher');
    await assertFails(setDoc(doc(db, 'staff/tch-create-fail'), {
      name: '교사-거부',
      email: 'teacher-fail@school.kr',
    }));
  });

  test('shortterm: staff update → 거부', async () => {
    // 규칙 우회로 문서 생성
    await env.withSecurityRulesDisabled(async (sec) => {
      await setDoc(doc(sec.firestore(), 'staff/st-update-fail'), {
        name: '단기-수정불가',
        department: '단기',
      });
    });
    const db = await ctxWithRole('st-write1', 'shortterm');
    await assertFails(updateDoc(doc(db, 'staff/st-update-fail'), {
      name: '수정시도',
    }));
  });
});
