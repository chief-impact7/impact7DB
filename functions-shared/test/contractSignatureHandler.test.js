import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

const {
  handleSubmitContractSignature,
  handleSubmitSalaryAgreementSignature,
} = await import('../src/contractSignatureHandler.js');

function ts(ms) {
  return { toMillis: () => ms };
}
const FUTURE = ts(Date.now() + 60 * 60 * 1000);
const PAST = ts(Date.now() - 60 * 60 * 1000);

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
// uploadSignedContractFile이 만드는 형태의 Firebase Storage 다운로드 URL(검증 통과).
const PDF = 'https://firebasestorage.googleapis.com/v0/b/impact7db/o/contracts%2Fx.pdf?alt=media&token=abc';

// dotted-path(예: 'signatures.staff') update를 흉내내며 nested set.
function applyPatch(obj, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes('.')) {
      const parts = k.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = { ...(cur[parts[i]] || {}) };
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = v;
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

function makeDb(initial = {}) {
  const data = { ...initial };
  function refFor(path) {
    return {
      _path: path,
      collection(sub) { return colFor(`${path}/${sub}`); },
      async get() {
        const d = data[path];
        return { exists: d !== undefined, id: path.split('/').pop(), data: () => d };
      },
    };
  }
  function colFor(path) {
    return { doc: (id) => refFor(`${path}/${id}`) };
  }
  return {
    _data: data,
    collection: (name) => colFor(name),
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        update(ref, patch) {
          if (data[ref._path] === undefined) throw new Error(`update on missing doc ${ref._path}`);
          data[ref._path] = applyPatch({ ...data[ref._path] }, patch);
        },
      };
      return fn(tx);
    },
  };
}

// ── 강사계약 서명 ─────────────────────────────────────────────────────────
function seedContract() {
  return makeDb({
    'contractSigningTokens/tok1': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
    'staff/s1': { name: '김강사', status: 'active' },
    'staff/s1/contracts/c1': { status: 'ready', signatures: { director: { signatureUrl: 'https://sig/dir.png' } } },
  });
}

describe('submitContractSignature — 유효 토큰', () => {
  it('강사 서명 + status=signed + 토큰 소진, staff.status는 불변(원장 서명 보존)', async () => {
    const db = seedContract();
    const res = await handleSubmitContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG, deviceInfo: 'UA/test', signedPdfUrl: PDF } },
      { firestore: db },
    );
    expect(res).toMatchObject({ ok: true, staffId: 's1', contractId: 'c1' });

    const contract = db._data['staff/s1/contracts/c1'];
    expect(contract.status).toBe('signed');
    expect(contract.signingTokenId).toBe('tok1');
    expect(contract.signatures.staff.signatureUrl).toBe(SIG);
    expect(contract.signatures.staff.deviceInfo).toBe('UA/test');
    expect(contract.signedPdfUrl).toBe(PDF);
    // 원장 서명은 서버가 건드리지 않으므로 그대로 보존(클라 직접 write였다면 덮어쓸 수 있었던 지점).
    expect(contract.signatures.director.signatureUrl).toBe('https://sig/dir.png');
    // 강사는 이미 재직 — status는 건드리지 않음(employee와의 차이).
    expect(db._data['staff/s1'].status).toBe('active');
    expect(db._data['contractSigningTokens/tok1'].status).toBe('signed');
  });

  it('signedPdfUrl 없으면 필드 미기록', async () => {
    const db = seedContract();
    await handleSubmitContractSignature({ data: { tokenId: 'tok1', signatureUrl: SIG } }, { firestore: db });
    expect(db._data['staff/s1/contracts/c1']).not.toHaveProperty('signedPdfUrl');
  });

  it('보안: signedPdfUrl이 Firebase Storage URL이 아니면(javascript:·외부) 거부, 아무 write 없음', async () => {
    const db = seedContract();
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG, signedPdfUrl: 'javascript:alert(document.cookie)' } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(db._data['staff/s1/contracts/c1'].status).toBe('ready');
  });

  it('계약 문서 없음 → not-found', async () => {
    const db = makeDb({
      'contractSigningTokens/tok1': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
    });
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('submitContractSignature — 입력/토큰/상태 검증', () => {
  it('보안: SVG data-URL 서명(저장형 XSS) → 거부, 아무 문서도 변경 안 됨', async () => {
    const db = seedContract();
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: 'data:image/svg+xml,<svg onload=alert(1)>' } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(db._data['staff/s1/contracts/c1'].status).toBe('ready');
    expect(db._data['staff/s1/contracts/c1'].signatures.staff).toBeUndefined();
  });

  it('존재하지 않는 토큰 → not-found', async () => {
    const db = seedContract();
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'nope', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'not-found' });
  });

  it('만료 토큰 → deadline-exceeded', async () => {
    const db = makeDb({
      'contractSigningTokens/tokX': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: PAST },
    });
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tokX', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'deadline-exceeded' });
  });

  it('contractId 불일치 → permission-denied', async () => {
    const db = seedContract();
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tok1', contractId: 'OTHER', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'permission-denied' });
    expect(db._data['staff/s1/contracts/c1'].status).toBe('ready');
  });

  it('토큰의 staffId가 path-traversal 문자열 → invalid-argument', async () => {
    const db = makeDb({
      'contractSigningTokens/tokT': { staffId: '../../etc', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
    });
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tokT', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('계약이 ready가 아니면 → failed-precondition', async () => {
    const db = makeDb({
      'contractSigningTokens/tok1': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
      'staff/s1/contracts/c1': { status: 'signed' },
    });
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('이중 제출: 재호출 → failed-precondition(소진된 토큰)', async () => {
    const db = seedContract();
    await handleSubmitContractSignature({ data: { tokenId: 'tok1', signatureUrl: SIG } }, { firestore: db });
    await expect(handleSubmitContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

// ── 급여약정 서명 ─────────────────────────────────────────────────────────
function seedSalary(contractStatus = 'salary_agreement_sent') {
  return makeDb({
    'salaryAgreementTokens/stok1': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
    'staff/s1': { name: '김강사', status: 'active' },
    'staff/s1/contracts/c1': { status: contractStatus, salaryAgreement: { amount: 3000000, status: 'sent' } },
  });
}

describe('submitSalaryAgreementSignature — 유효 토큰', () => {
  it('salaryAgreement 중첩만 갱신 + 토큰 소진, 계약 status·amount 보존', async () => {
    const db = seedSalary();
    const res = await handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: SIG, salaryPdfUrl: PDF } },
      { firestore: db },
    );
    expect(res).toMatchObject({ ok: true, staffId: 's1', contractId: 'c1' });

    const contract = db._data['staff/s1/contracts/c1'];
    expect(contract.status).toBe('salary_agreement_sent'); // 계약 status 불변
    expect(contract.salaryAgreement.status).toBe('signed');
    expect(contract.salaryAgreement.signatureUrl).toBe(SIG);
    expect(contract.salaryAgreement.amount).toBe(3000000); // 기존 약정 필드 보존
    expect(contract.agreementTokenId).toBe('stok1');
    expect(contract.salaryPdfUrl).toBe(PDF);
    expect(db._data['salaryAgreementTokens/stok1'].status).toBe('signed');
  });

  it('계약 status가 signed여도 서명 가능', async () => {
    const db = seedSalary('signed');
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: SIG } }, { firestore: db },
    )).resolves.toMatchObject({ ok: true });
  });

  it('salaryPdfUrl 없으면 필드 미기록', async () => {
    const db = seedSalary();
    await handleSubmitSalaryAgreementSignature({ data: { tokenId: 'stok1', signatureUrl: SIG } }, { firestore: db });
    expect(db._data['staff/s1/contracts/c1']).not.toHaveProperty('salaryPdfUrl');
  });
});

describe('submitSalaryAgreementSignature — 검증', () => {
  it('보안: SVG data-URL → 거부', async () => {
    const db = seedSalary();
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: 'data:image/svg+xml,<svg onload=alert(1)>' } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(db._data['staff/s1/contracts/c1'].salaryAgreement.status).toBe('sent');
  });

  it('계약 status가 서명 가능 상태(signed/salary_agreement_sent)가 아니면 → failed-precondition', async () => {
    const db = seedSalary('ready');
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('이중 제출: 재호출 → failed-precondition', async () => {
    const db = seedSalary();
    await handleSubmitSalaryAgreementSignature({ data: { tokenId: 'stok1', signatureUrl: SIG } }, { firestore: db });
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('contractId 불일치 → permission-denied', async () => {
    const db = seedSalary();
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', contractId: 'OTHER', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('토큰의 staffId가 path-traversal 문자열 → invalid-argument', async () => {
    const db = makeDb({
      'salaryAgreementTokens/stok1': { staffId: '../../etc', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
    });
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('계약 문서 없음 → not-found', async () => {
    const db = makeDb({
      'salaryAgreementTokens/stok1': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
    });
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: SIG } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'not-found' });
  });

  it('보안: salaryPdfUrl이 Firebase Storage URL이 아니면 거부', async () => {
    const db = seedSalary();
    await expect(handleSubmitSalaryAgreementSignature(
      { data: { tokenId: 'stok1', signatureUrl: SIG, salaryPdfUrl: 'https://evil.example/x.pdf' } }, { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(db._data['staff/s1/contracts/c1'].salaryAgreement.status).toBe('sent');
  });
});
