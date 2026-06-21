import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));

const {
  handleGetHrPublicToken,
  maskResidentNumber,
  maskAccountNumber,
} = await import('../src/hrPublicTokenHandler.js');

// epoch ms를 firestore Timestamp 흉내 객체로.
function ts(ms) {
  return { toMillis: () => ms };
}

const FUTURE = ts(Date.now() + 60 * 60 * 1000);
const PAST = ts(Date.now() - 60 * 60 * 1000);

// 경로별 doc을 path 문자열로 매핑하는 가짜 Firestore.
// docs: { 'col/id': data, 'col/id/sub/sid': data, ... }. 없는 경로는 exists:false.
function makeDb(docs) {
  function docRef(path) {
    return {
      collection: (sub) => colRef(`${path}/${sub}`),
      async get() {
        const data = docs[path];
        const id = path.split('/').pop();
        return data == null
          ? { exists: false }
          : { exists: true, id, data: () => data };
      },
    };
  }
  function colRef(path) {
    return { doc: (id) => docRef(`${path}/${id}`) };
  }
  return { collection: (name) => colRef(name) };
}

const SENSITIVE = ['residentNumber', 'bankInfo', 'taxInfo', 'accountNumber', '900101-1234567', '110234567890'];

function assertNoSensitive(payload) {
  const json = JSON.stringify(payload);
  // 마스킹 키(residentNumberMasked/accountNumberMasked)는 허용하되 평문 키/값은 금지.
  expect(json).not.toContain('"residentNumber"');
  expect(json).not.toContain('"accountNumber"');
  expect(json).not.toContain('"taxInfo"');
  expect(json).not.toContain('900101-1234567'); // 평문 주민번호
  expect(json).not.toContain('1234567'); // 주민번호 뒷자리
  expect(json).not.toContain('110234567890'); // 평문 계좌번호
}

describe('mask helpers', () => {
  it('masks resident number to YYMMDD-N******', () => {
    expect(maskResidentNumber('900101-1234567')).toBe('900101-1******');
    expect(maskResidentNumber('9001011234567')).toBe('900101-1******');
    expect(maskResidentNumber('')).toBeNull();
    expect(maskResidentNumber('123')).toBeNull();
  });

  it('masks account number to last 4 digits only', () => {
    expect(maskAccountNumber('110234567890')).toBe('********7890');
    expect(maskAccountNumber('110-234-567890')).toBe('********7890');
    expect(maskAccountNumber('12')).toBe('12');
    expect(maskAccountNumber('')).toBeNull();
  });
});

describe('handleGetHrPublicToken — validation', () => {
  it('rejects an unknown tokenType', async () => {
    const db = makeDb({});
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'bogus', tokenId: 't1' } }, { db }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a missing tokenId', async () => {
    const db = makeDb({});
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'onboarding' } }, { db }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a nonexistent token (not-found)', async () => {
    const db = makeDb({});
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'onboarding', tokenId: 'nope' } }, { db }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects an expired token (deadline-exceeded)', async () => {
    const db = makeDb({
      'onboardingTokens/t1': { staffName: '김강사', status: 'pending', expiresAt: PAST },
    });
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'onboarding', tokenId: 't1' } }, { db }),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' });
  });

  it('rejects a completed onboarding token (failed-precondition)', async () => {
    const db = makeDb({
      'onboardingTokens/t1': { staffName: '김강사', status: 'completed', expiresAt: FUTURE },
    });
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'onboarding', tokenId: 't1' } }, { db }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a signed contract token (failed-precondition)', async () => {
    const db = makeDb({
      'contractSigningTokens/t1': { staffId: 's1', contractId: 'c1', staffName: '김강사', status: 'signed', expiresAt: FUTURE },
    });
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'contractSigning', tokenId: 't1' } }, { db }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('handleGetHrPublicToken — onboarding family', () => {
  it('returns only the target name for onboarding', async () => {
    const db = makeDb({
      'onboardingTokens/t1': { staffName: '김강사', createdBy: 'admin@impact7.kr', status: 'pending', expiresAt: FUTURE },
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'onboarding', tokenId: 't1' } }, { db });
    expect(res).toEqual({ tokenType: 'onboarding', targetName: '김강사' });
  });

  it('returns the target name for employeeOnboarding', async () => {
    const db = makeDb({
      'employeeOnboardingTokens/t1': { staffName: '이직원', status: 'pending', expiresAt: FUTURE },
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'employeeOnboarding', tokenId: 't1' } }, { db });
    expect(res).toEqual({ tokenType: 'employeeOnboarding', targetName: '이직원' });
  });

  it('returns the target name for shortTerm (name field)', async () => {
    const db = makeDb({
      'shortTermTokens/t1': { name: '박단기', status: 'pending', expiresAt: FUTURE },
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'shortTerm', tokenId: 't1' } }, { db });
    expect(res).toEqual({ tokenType: 'shortTerm', targetName: '박단기' });
  });
});

describe('handleGetHrPublicToken — contract signing', () => {
  const staffDoc = {
    name: '김강사',
    phone: '010-1234-5678',
    address: '서울시 강남구',
    residentNumber: '900101-1234567',
    bankInfo: { bank: 'KB국민은행', accountNumber: '110234567890', holder: '김강사' },
    taxInfo: { taxType: '근로소득', dependents: 1, hasOtherIncome: false },
    documents: { idCopy: 'data:image/png;base64,SCAN', bankbook: null },
  };
  const contractDoc = {
    contractType: '4대보험',
    status: 'ready',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    paymentTerms: { type: 'monthly', monthlySalary: 3000000, hourlyRate: null, projectFee: null },
    entityId: 'e1',
    entitySnapshot: { name: '임팩트세븐학원', representative: '이종수', address: '서울' },
    specialTerms: ['특약1'],
    signatures: { director: null, staff: null },
  };

  it('returns masked party + contract content, never sensitive fields', async () => {
    const db = makeDb({
      'contractSigningTokens/t1': { staffId: 's1', contractId: 'c1', staffName: '김강사', status: 'pending', expiresAt: FUTURE },
      'staff/s1': staffDoc,
      'staff/s1/contracts/c1': contractDoc,
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'contractSigning', tokenId: 't1' } }, { db });

    expect(res.tokenType).toBe('contractSigning');
    expect(res.targetName).toBe('김강사');
    expect(res.party).toEqual({
      name: '김강사',
      phone: '010-1234-5678',
      address: '서울시 강남구',
      residentNumberMasked: '900101-1******',
      bankInfo: { bank: 'KB국민은행', accountNumberMasked: '********7890', holder: '김강사' },
    });
    expect(res.contract).toMatchObject({
      id: 'c1',
      contractType: '4대보험',
      paymentTerms: { type: 'monthly', monthlySalary: 3000000 },
      specialTerms: ['특약1'],
    });
    // CRUCIAL: 민감 평문 미노출
    assertNoSensitive(res);
    expect(JSON.stringify(res)).not.toContain('SCAN'); // 문서스캔 미반환
  });

  it('서명 메타 최소화: 원장 서명 이미지만 노출, deviceInfo(UA)·signedAt 미노출 (M-1)', async () => {
    const db = makeDb({
      'contractSigningTokens/t1': { staffId: 's1', contractId: 'c1', staffName: '김강사', status: 'pending', expiresAt: FUTURE },
      'staff/s1': staffDoc,
      'staff/s1/contracts/c1': {
        ...contractDoc,
        signatures: {
          director: { signatureUrl: 'https://sig/director.png', deviceInfo: 'Mozilla/5.0 SECRET-UA', signedAt: 'X' },
          staff: null,
        },
      },
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'contractSigning', tokenId: 't1' } }, { db });
    expect(res.contract.signatures).toEqual({
      director: { signatureUrl: 'https://sig/director.png' },
      staffSigned: false,
      employeeSigned: false,
    });
    expect(JSON.stringify(res)).not.toContain('SECRET-UA');
  });

  it('만료필드 없으면 거부 (fail-closed, L-2)', async () => {
    const db = makeDb({
      'onboardingTokens/t1': { staffName: '김강사', status: 'pending' },
    });
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'onboarding', tokenId: 't1' } }, { db }),
    ).rejects.toMatchObject({ code: 'deadline-exceeded' });
  });

  it('rejects when the contract subdoc is missing (not-found)', async () => {
    const db = makeDb({
      'contractSigningTokens/t1': { staffId: 's1', contractId: 'c1', staffName: '김강사', status: 'pending', expiresAt: FUTURE },
      'staff/s1': staffDoc,
    });
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'contractSigning', tokenId: 't1' } }, { db }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects a wrong tokenType pointed at the same id', async () => {
    // contractSigning 토큰을 employeeContractSigning으로 조회 → employeeContractSigningTokens에 없음.
    const db = makeDb({
      'contractSigningTokens/t1': { staffId: 's1', contractId: 'c1', staffName: '김강사', status: 'pending', expiresAt: FUTURE },
      'staff/s1': staffDoc,
      'staff/s1/contracts/c1': contractDoc,
    });
    await expect(
      handleGetHrPublicToken({ data: { tokenType: 'employeeContractSigning', tokenId: 't1' } }, { db }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('handleGetHrPublicToken — employee contract signing', () => {
  const employeeDoc = {
    name: '이직원',
    phone: '010-9999-0000',
    address: '서울시 양천구',
    residentNumber: '950505-2345678',
    bankInfo: { bank: '신한은행', accountNumber: '99887766554', holder: '이직원' },
    taxInfo: { taxType: '근로소득', dependents: 2, hasOtherIncome: false },
  };
  const contractDoc = {
    contractType: '정식(4대보험)',
    status: 'ready',
    startDate: '2026-02-01',
    endDate: '2027-01-31',
    workContent: '학원 행정',
    paymentTerms: { type: 'monthly', monthlySalary: 2500000, dailyWage: null, hourlyRate: null },
    workHours: { start: '09:00', end: '18:00', breakTime: 60 },
    entityId: 'e1',
    specialTerms: [],
    signatures: { employee: null },
  };

  it('returns masked employee + contract, never sensitive fields', async () => {
    const db = makeDb({
      'employeeContractSigningTokens/t1': { employeeId: 'em1', contractId: 'c9', employeeName: '이직원', status: 'pending', expiresAt: FUTURE },
      'employees/em1': employeeDoc,
      'employees/em1/contracts/c9': contractDoc,
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'employeeContractSigning', tokenId: 't1' } }, { db });

    expect(res.party.residentNumberMasked).toBe('950505-2******');
    expect(res.party.bankInfo.accountNumberMasked).toBe('*******6554');
    expect(res.contract).toMatchObject({ id: 'c9', contractType: '정식(4대보험)', workContent: '학원 행정' });
    assertNoSensitive(res);
    expect(JSON.stringify(res)).not.toContain('99887766554');
    expect(JSON.stringify(res)).not.toContain('950505-2345678');
  });
});

describe('handleGetHrPublicToken — salary agreement', () => {
  it('returns token-carried amount + masked staff, never sensitive fields', async () => {
    const db = makeDb({
      'salaryAgreementTokens/t1': {
        staffId: 's1', contractId: 'c1', staffName: '김강사', contractType: '4대보험',
        amount: 3000000, probation: { months: 3, salaryPercent: 90 },
        retirementFund: { type: 'separate', ratio: '1/13' },
        status: 'pending', expiresAt: FUTURE,
      },
      'staff/s1': {
        name: '김강사', phone: '010-1234-5678', address: '서울', residentNumber: '900101-1234567',
        bankInfo: { bank: 'KB국민은행', accountNumber: '110234567890', holder: '김강사' },
        taxInfo: { taxType: '근로소득' },
      },
      'staff/s1/contracts/c1': { entityId: 'e1', entitySnapshot: { name: '임팩트세븐학원' } },
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'salaryAgreement', tokenId: 't1' } }, { db });

    expect(res.targetName).toBe('김강사');
    expect(res.party.residentNumberMasked).toBe('900101-1******');
    expect(res.agreement).toEqual({
      contractType: '4대보험',
      amount: 3000000,
      probation: { months: 3, salaryPercent: 90 },
      retirementFund: { type: 'separate', ratio: '1/13' },
    });
    expect(res.entityId).toBe('e1');
    expect(res.entitySnapshot).toEqual({ name: '임팩트세븐학원' });
    assertNoSensitive(res);
  });

  it('tolerates a missing staff master (party null) but still returns agreement', async () => {
    const db = makeDb({
      'salaryAgreementTokens/t1': {
        staffId: 's1', contractId: 'c1', staffName: '김강사', contractType: '프리랜서(3.3%)',
        amount: 1500000, status: 'pending', expiresAt: FUTURE,
      },
    });
    const res = await handleGetHrPublicToken({ data: { tokenType: 'salaryAgreement', tokenId: 't1' } }, { db });
    expect(res.party).toBeNull();
    expect(res.agreement.amount).toBe(1500000);
    expect(res.entityId).toBeNull();
  });
});
