import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn() }));
vi.mock('firebase-admin/storage', () => ({ getStorage: vi.fn() }));

const {
  handleHrUploadStaffDocument,
  handleHrUploadContract,
  handleHrUploadSignedContract,
  handleHrGetFileUrl,
} = await import('../src/hrUploadHandler.js');

const auth = { uid: 'u1', token: { email: 'director@impact7.kr' } };

function ts(ms) {
  return { toMillis: () => ms };
}
const FUTURE = ts(Date.now() + 60 * 60 * 1000);
const PAST = ts(Date.now() - 60 * 60 * 1000);

// 작은 유효 PDF / PNG / TXT를 base64로.
const PDF_B64 = Buffer.from('%PDF-1.4\n%mock pdf body\n').toString('base64');
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const TXT_B64 = Buffer.from('hello not a real file').toString('base64');

// HR_users 역할 게이트 + 토큰 doc read를 흉내내는 firestore mock.
function makeFirestore({ role = 'owner', tokens = {} } = {}) {
  return {
    collection(name) {
      if (name === 'HR_users') {
        return { doc: () => ({ get: async () => (role ? { exists: true, data: () => ({ role }) } : { exists: false }) }) };
      }
      // 토큰 컬렉션: tokens[`${name}/${id}`]
      return {
        doc: (id) => ({
          get: async () => {
            const data = tokens[`${name}/${id}`];
            return data == null ? { exists: false } : { exists: true, id, data: () => data };
          },
        }),
      };
    },
  };
}

// getStorage().bucket() 흉내 — save/exists/getMetadata/setMetadata 기록.
function makeBucket({ existing = {} } = {}) {
  const saved = [];
  const meta = { ...existing };
  return {
    name: 'impact7db.firebasestorage.app',
    _saved: saved,
    file(path) {
      return {
        async save(buffer, opts) {
          saved.push({ path, size: buffer.length, opts });
        },
        async exists() {
          return [meta[path] !== undefined];
        },
        async getMetadata() {
          return [meta[path] ?? { metadata: {} }];
        },
        async setMetadata(m) {
          meta[path] = { ...(meta[path] ?? {}), metadata: { ...(meta[path]?.metadata ?? {}), ...m.metadata } };
        },
      };
    },
  };
}

describe('hrUploadStaffDocument — auth + role gate', () => {
  it('requires auth', async () => {
    await expect(handleHrUploadStaffDocument(
      { data: { staffId: 's1', dataBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects non-impact7 email', async () => {
    await expect(handleHrUploadStaffDocument(
      { auth: { uid: 'u', token: { email: 'x@gmail.com' } }, data: { staffId: 's1', dataBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a non-director staff account', async () => {
    await expect(handleHrUploadStaffDocument(
      { auth, data: { staffId: 's1', dataBase64: PDF_B64 } },
      { firestore: makeFirestore({ role: 'staff' }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('requires staffId', async () => {
    await expect(handleHrUploadStaffDocument(
      { auth, data: { dataBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a staffId with path-traversal characters', async () => {
    await expect(handleHrUploadStaffDocument(
      { auth, data: { staffId: '../../etc', dataBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('hrUploadStaffDocument — server-side validation', () => {
  it('rejects a non-PDF/non-image payload (magic-number check)', async () => {
    await expect(handleHrUploadStaffDocument(
      { auth, data: { staffId: 's1', fileName: 'x.pdf', contentType: 'application/pdf', dataBase64: TXT_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an oversized file (>20MB)', async () => {
    const big = 'A'.repeat(21 * 1024 * 1024 * 4 / 3 | 0); // base64 length over the cap
    await expect(handleHrUploadStaffDocument(
      { auth, data: { staffId: 's1', dataBase64: big } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects when declared type contradicts actual bytes', async () => {
    // PNG bytes but declared application/pdf → mismatch.
    await expect(handleHrUploadStaffDocument(
      { auth, data: { staffId: 's1', contentType: 'application/pdf', dataBase64: PNG_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('writes a PDF to staff/{staffId}/documents/{ts}_{safeName} and returns a download URL', async () => {
    const bucket = makeBucket();
    const res = await handleHrUploadStaffDocument(
      { auth, data: { staffId: 's1', fileName: '주민등록 등본 (1).pdf', contentType: 'application/pdf', dataBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket },
    );
    expect(bucket._saved).toHaveLength(1);
    const path = bucket._saved[0].path;
    // 한글·공백·괄호는 모두 _로 정규화된다(영숫자·._- 만 보존). 끝은 _1_.pdf.
    expect(path).toMatch(/^staff\/s1\/documents\/\d+_[_]+1_\.pdf$/);
    expect(bucket._saved[0].opts.metadata.contentType).toBe('application/pdf');
    expect(bucket._saved[0].opts.metadata.metadata.firebaseStorageDownloadTokens).toBeTruthy();
    expect(res.path).toBe(path);
    expect(res.downloadUrl).toContain('https://firebasestorage.googleapis.com/v0/b/impact7db.firebasestorage.app/o/');
    expect(res.downloadUrl).toContain('alt=media&token=');
  });

  it('accepts an image (PNG) document', async () => {
    const bucket = makeBucket();
    const res = await handleHrUploadStaffDocument(
      { auth, data: { staffId: 's2', fileName: 'id.png', contentType: 'image/png', dataBase64: PNG_B64 } },
      { firestore: makeFirestore({}), bucket },
    );
    expect(bucket._saved[0].opts.metadata.contentType).toBe('image/png');
    expect(res.path).toMatch(/^staff\/s2\/documents\/\d+_id\.png$/);
  });
});

describe('hrUploadContract — admin', () => {
  it('rejects a non-director', async () => {
    await expect(handleHrUploadContract(
      { auth, data: { ownerId: 's1', contractId: 'c1', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ role: 'staff' }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('requires ownerId + contractId', async () => {
    await expect(handleHrUploadContract(
      { auth, data: { type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects ownerId/contractId with traversal characters', async () => {
    await expect(handleHrUploadContract(
      { auth, data: { ownerId: 's1', contractId: 'c1/../../staff/victim', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an invalid type', async () => {
    await expect(handleHrUploadContract(
      { auth, data: { ownerId: 's1', contractId: 'c1', type: 'bogus', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a non-PDF payload', async () => {
    await expect(handleHrUploadContract(
      { auth, data: { ownerId: 's1', contractId: 'c1', type: 'contract', pdfBase64: PNG_B64 } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('writes to contracts/{ownerId}/{contractId}/{type}_signed.pdf', async () => {
    const bucket = makeBucket();
    const res = await handleHrUploadContract(
      { auth, data: { ownerId: 's1', contractId: 'c1', type: 'salary', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({}), bucket },
    );
    expect(bucket._saved[0].path).toBe('contracts/s1/c1/salary_signed.pdf');
    expect(res.path).toBe('contracts/s1/c1/salary_signed.pdf');
  });
});

describe('hrUploadSignedContract — public token gate (HR-13 fix)', () => {
  const tokens = {
    'contractSigningTokens/t1': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
    'salaryAgreementTokens/t2': { staffId: 's2', contractId: 'c2', status: 'pending', expiresAt: FUTURE },
    'employeeContractSigningTokens/t3': { employeeId: 'em1', contractId: 'c3', status: 'pending', expiresAt: FUTURE },
  };

  it('rejects an unknown tokenType', async () => {
    await expect(handleHrUploadSignedContract(
      { data: { tokenType: 'bogus', tokenId: 't1', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ tokens }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a nonexistent token (not-found)', async () => {
    await expect(handleHrUploadSignedContract(
      { data: { tokenType: 'contractSigning', tokenId: 'nope', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ tokens }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects an expired token (deadline-exceeded)', async () => {
    await expect(handleHrUploadSignedContract(
      { data: { tokenType: 'contractSigning', tokenId: 'tx', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ tokens: { 'contractSigningTokens/tx': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: PAST } } }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'deadline-exceeded' });
  });

  it('rejects an already-signed token (failed-precondition)', async () => {
    await expect(handleHrUploadSignedContract(
      { data: { tokenType: 'contractSigning', tokenId: 'ts', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ tokens: { 'contractSigningTokens/ts': { staffId: 's1', contractId: 'c1', status: 'signed', expiresAt: FUTURE } } }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('derives ownerId/contractId FROM THE TOKEN, ignoring caller-supplied ids', async () => {
    const bucket = makeBucket();
    const res = await handleHrUploadSignedContract(
      // caller tries to inject a different ownerId/contractId — must be ignored.
      { data: { tokenType: 'contractSigning', tokenId: 't1', type: 'contract', pdfBase64: PDF_B64, ownerId: 'EVIL', contractId: 'EVIL' } },
      { firestore: makeFirestore({ tokens }), bucket },
    );
    expect(bucket._saved[0].path).toBe('contracts/s1/c1/contract_signed.pdf');
    expect(res.path).toBe('contracts/s1/c1/contract_signed.pdf');
  });

  it('uses employeeId as owner for employee contract tokens', async () => {
    const bucket = makeBucket();
    await handleHrUploadSignedContract(
      { data: { tokenType: 'employeeContractSigning', tokenId: 't3', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ tokens }), bucket },
    );
    expect(bucket._saved[0].path).toBe('contracts/em1/c3/contract_signed.pdf');
  });

  it('writes salary PDF via salaryAgreement token', async () => {
    const bucket = makeBucket();
    await handleHrUploadSignedContract(
      { data: { tokenType: 'salaryAgreement', tokenId: 't2', type: 'salary', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ tokens }), bucket },
    );
    expect(bucket._saved[0].path).toBe('contracts/s2/c2/salary_signed.pdf');
  });

  it('rejects a non-PDF signed payload', async () => {
    await expect(handleHrUploadSignedContract(
      { data: { tokenType: 'contractSigning', tokenId: 't1', type: 'contract', pdfBase64: PNG_B64 } },
      { firestore: makeFirestore({ tokens }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('write-once: rejects a second upload when the signed PDF already exists (replay/overwrite guard)', async () => {
    const path = 'contracts/s1/c1/contract_signed.pdf';
    const bucket = makeBucket({ existing: { [path]: { metadata: {} } } });
    await expect(handleHrUploadSignedContract(
      { data: { tokenType: 'contractSigning', tokenId: 't1', type: 'contract', pdfBase64: PDF_B64 } },
      { firestore: makeFirestore({ tokens }), bucket },
    )).rejects.toMatchObject({ code: 'already-exists' });
  });
});

describe('hrGetFileUrl', () => {
  const tokens = {
    'contractSigningTokens/t1': { staffId: 's1', contractId: 'c1', status: 'pending', expiresAt: FUTURE },
  };

  it('requires a path', async () => {
    await expect(handleHrGetFileUrl(
      { auth, data: {} },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('authenticated: rejects a non-director', async () => {
    await expect(handleHrGetFileUrl(
      { auth, data: { path: 'staff/s1/documents/1_a.pdf' } },
      { firestore: makeFirestore({ role: 'staff' }), bucket: makeBucket({ existing: { 'staff/s1/documents/1_a.pdf': { metadata: {} } } }) },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('authenticated: rejects a path outside staff/ and contracts/', async () => {
    await expect(handleHrGetFileUrl(
      { auth, data: { path: 'exam-papers/secret.pdf' } },
      { firestore: makeFirestore({}), bucket: makeBucket({ existing: { 'exam-papers/secret.pdf': {} } }) },
    )).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('authenticated director: returns a token-based URL for an existing staff file', async () => {
    const path = 'staff/s1/documents/1_a.pdf';
    const bucket = makeBucket({ existing: { [path]: { metadata: { firebaseStorageDownloadTokens: 'EXISTING-TOK' } } } });
    const res = await handleHrGetFileUrl({ auth, data: { path } }, { firestore: makeFirestore({}), bucket });
    expect(res.downloadUrl).toContain('token=EXISTING-TOK');
  });

  it('authenticated: 404 for a missing file', async () => {
    await expect(handleHrGetFileUrl(
      { auth, data: { path: 'contracts/s1/c1/contract_signed.pdf' } },
      { firestore: makeFirestore({}), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'not-found' });
  });

  it('public token: allows only files under the token contract path', async () => {
    const path = 'contracts/s1/c1/contract_signed.pdf';
    const bucket = makeBucket({ existing: { [path]: { metadata: { firebaseStorageDownloadTokens: 'T' } } } });
    const res = await handleHrGetFileUrl(
      { data: { path, tokenType: 'contractSigning', tokenId: 't1' } },
      { firestore: makeFirestore({ tokens }), bucket },
    );
    expect(res.downloadUrl).toContain('token=T');
  });

  it('public token: rejects a path outside the token contract path', async () => {
    await expect(handleHrGetFileUrl(
      { data: { path: 'contracts/OTHER/cX/contract_signed.pdf', tokenType: 'contractSigning', tokenId: 't1' } },
      { firestore: makeFirestore({ tokens }), bucket: makeBucket() },
    )).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('public token: does NOT mint a token for a file that lacks one (no immortal public URLs)', async () => {
    const path = 'contracts/s1/c1/contract_signed.pdf';
    const bucket = makeBucket({ existing: { [path]: { metadata: {} } } });
    await expect(handleHrGetFileUrl(
      { data: { path, tokenType: 'contractSigning', tokenId: 't1' } },
      { firestore: makeFirestore({ tokens }), bucket },
    )).rejects.toMatchObject({ code: 'not-found' });
  });

  it('authenticated director: mints a token when the file lacks one', async () => {
    const path = 'contracts/s1/c1/contract_signed.pdf';
    const bucket = makeBucket({ existing: { [path]: { metadata: {} } } });
    const res = await handleHrGetFileUrl({ auth, data: { path } }, { firestore: makeFirestore({}), bucket });
    expect(res.downloadUrl).toMatch(/token=[0-9a-f-]{36}$/);
  });
});
