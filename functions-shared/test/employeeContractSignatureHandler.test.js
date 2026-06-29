import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: vi.fn(),
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

const { handleSubmitEmployeeContractSignature } = await import('../src/employeeContractSignatureHandler.js');

function ts(ms) {
  return { toMillis: () => ms };
}
const FUTURE = ts(Date.now() + 60 * 60 * 1000);
const PAST = ts(Date.now() - 60 * 60 * 1000);

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

// dotted-path(예: 'signatures.employee') update를 흉내내며 nested set.
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

// 경로 문자열 키로 staff/contracts/token doc을 흉내내는 firestore mock(+ runTransaction).
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

// 정상 시드: pending 토큰 + ready 계약 + staff 문서(status onboarding).
function seedHappy() {
  return makeDb({
    'employeeContractSigningTokens/tok1': { employeeId: 'em1', contractId: 'c3', status: 'pending', expiresAt: FUTURE },
    'staff/em1': { name: '신규직원', status: 'onboarding', department: '행정' },
    'staff/em1/contracts/c3': { status: 'ready', assignedTo: 'someuid' },
  });
}

describe('submitEmployeeContractSignature — 유효 토큰', () => {
  it('계약 서명 + 계약 status=signed + staff.status=active + 토큰 소진을 원자 갱신', async () => {
    const db = seedHappy();
    const res = await handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG, deviceInfo: 'UA/test' } },
      { firestore: db },
    );

    expect(res).toMatchObject({ ok: true, employeeId: 'em1', contractId: 'c3' });

    const contract = db._data['staff/em1/contracts/c3'];
    expect(contract.status).toBe('signed');
    expect(contract.signingTokenId).toBe('tok1');
    expect(contract.signatures.employee.signatureUrl).toBe(SIG);
    expect(contract.signatures.employee.deviceInfo).toBe('UA/test');

    expect(db._data['staff/em1'].status).toBe('active');
    expect(db._data['employeeContractSigningTokens/tok1'].status).toBe('signed');
  });

  it('contractId를 함께 보내도 토큰 값과 일치하면 성공', async () => {
    const db = seedHappy();
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', contractId: 'c3', signatureUrl: SIG } },
      { firestore: db },
    )).resolves.toMatchObject({ ok: true });
  });
});

describe('submitEmployeeContractSignature — 입력/토큰 검증', () => {
  it('서명 이미지(data:image/png|jpeg base64)가 아니면 거부', async () => {
    const db = seedHappy();
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: 'https://evil/x.png' } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('보안: data:image/svg+xml 서명(저장형 XSS 벡터) → 거부', async () => {
    const db = seedHappy();
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: 'data:image/svg+xml,<svg onload=alert(1)>' } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
    // 거부 시 어떤 문서도 변경되지 않음(서명 미기록).
    expect(db._data['staff/em1'].status).toBe('onboarding');
  });

  it('존재하지 않는 토큰 → not-found', async () => {
    const db = seedHappy();
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'nope', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'not-found' });
  });

  it('만료된 토큰 → deadline-exceeded', async () => {
    const db = makeDb({
      'employeeContractSigningTokens/tokX': { employeeId: 'em1', contractId: 'c3', status: 'pending', expiresAt: PAST },
      'staff/em1': { status: 'onboarding' },
      'staff/em1/contracts/c3': { status: 'ready' },
    });
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tokX', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'deadline-exceeded' });
  });

  it('이미 사용된 토큰(status=signed) → failed-precondition', async () => {
    const db = makeDb({
      'employeeContractSigningTokens/tokU': { employeeId: 'em1', contractId: 'c3', status: 'signed', expiresAt: FUTURE },
      'staff/em1': { status: 'active' },
      'staff/em1/contracts/c3': { status: 'signed' },
    });
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tokU', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('contractId 불일치(호출자 제출) → permission-denied', async () => {
    const db = seedHappy();
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', contractId: 'OTHER', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'permission-denied' });
    // 거부 시 어떤 문서도 변경되지 않음
    expect(db._data['staff/em1'].status).toBe('onboarding');
    expect(db._data['staff/em1/contracts/c3'].status).toBe('ready');
  });

  it('토큰의 employeeId가 path-traversal 문자열 → invalid-argument', async () => {
    const db = makeDb({
      'employeeContractSigningTokens/tokT': { employeeId: '../../etc', contractId: 'c3', status: 'pending', expiresAt: FUTURE },
    });
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tokT', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('submitEmployeeContractSignature — 계약 상태/원자성', () => {
  it('계약 문서 없음 → not-found', async () => {
    const db = makeDb({
      'employeeContractSigningTokens/tok1': { employeeId: 'em1', contractId: 'c3', status: 'pending', expiresAt: FUTURE },
      'staff/em1': { status: 'onboarding' },
    });
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'not-found' });
  });

  it('계약이 ready가 아니면(이미 signed) → failed-precondition', async () => {
    const db = makeDb({
      'employeeContractSigningTokens/tok1': { employeeId: 'em1', contractId: 'c3', status: 'pending', expiresAt: FUTURE },
      'staff/em1': { status: 'onboarding' },
      'staff/em1/contracts/c3': { status: 'signed' },
    });
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('이중 제출: 첫 호출 성공 후 같은 토큰 재호출 → failed-precondition(소진된 토큰)', async () => {
    const db = seedHappy();
    await handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG } },
      { firestore: db },
    );
    await expect(handleSubmitEmployeeContractSignature(
      { data: { tokenId: 'tok1', signatureUrl: SIG } },
      { firestore: db },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
