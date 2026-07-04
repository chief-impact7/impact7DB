import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { loadValidToken } from './hrPublicTokenHandler.js';
import { assertSafePathId, assertSignatureDataUrl, assertStorageUrlOrEmpty } from './hrStorage.js';

// 공개(비로그인) 강사계약·급여약정 서명 제출을 서버 callable로 이관.
// 기존 클라 플로우는 비인증 사용자가 staff/{id}/contracts/{id}에 signatures를 직접 write 했고,
// firestore.rules는 최상위 키(hasOnly)만 검증해 signatures.director 덮어쓰기나
// SVG data-URL(저장형 XSS) 주입을 막지 못했다. Admin SDK(rules 우회)로 토큰을 검증한 뒤
// 자기 서명만 write하고 토큰을 단일 트랜잭션으로 소진한다. 경로 ID는 토큰 doc에서만 도출.
// (근로계약 서명은 submitEmployeeContractSignature — staff.status='active'까지 처리 — 로 분리.)

function textOf(v) {
  return String(v ?? '').trim();
}

// 강사계약 서명(ready→signed). employee와 달리 staff.status는 건드리지 않는다(강사는 이미 재직).
export async function handleSubmitContractSignature(request, deps = {}) {
  const db = deps.firestore ?? getFirestore();
  const data = request?.data ?? {};

  const tokenId = textOf(data.tokenId);
  const signatureUrl = assertSignatureDataUrl(data.signatureUrl);
  const deviceInfo = textOf(data.deviceInfo);
  const signedPdfUrl = assertStorageUrlOrEmpty(data.signedPdfUrl);
  const claimedContractId = textOf(data.contractId);

  const { token } = await loadValidToken(db, 'contractSigning', tokenId);
  const staffId = assertSafePathId(token.staffId, '계약 정보');
  const contractId = assertSafePathId(token.contractId, '계약 정보');
  if (claimedContractId && claimedContractId !== contractId) {
    throw new HttpsError('permission-denied', '계약 정보가 일치하지 않습니다.');
  }

  const tokenRef = db.collection('contractSigningTokens').doc(tokenId);
  const contractRef = db.collection('staff').doc(staffId).collection('contracts').doc(contractId);

  await db.runTransaction(async (tx) => {
    const [tokenSnap, contractSnap] = await Promise.all([tx.get(tokenRef), tx.get(contractRef)]);
    if (!tokenSnap.exists || tokenSnap.data().status !== 'pending') {
      throw new HttpsError('failed-precondition', '이미 처리된 링크입니다.');
    }
    if (!contractSnap.exists) {
      throw new HttpsError('not-found', '계약서를 찾을 수 없습니다.');
    }
    if (contractSnap.data().status !== 'ready') {
      throw new HttpsError('failed-precondition', '서명할 수 없는 계약 상태입니다.');
    }

    const contractUpdate = {
      'signatures.staff': {
        signatureUrl,
        signedAt: FieldValue.serverTimestamp(),
        deviceInfo,
      },
      status: 'signed',
      signingTokenId: tokenId,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (signedPdfUrl) contractUpdate.signedPdfUrl = signedPdfUrl;

    tx.update(contractRef, contractUpdate);
    tx.update(tokenRef, { status: 'signed', signedAt: FieldValue.serverTimestamp() });
  });

  return { ok: true, staffId, contractId };
}

// 급여약정 서명. 계약 status는 불변(director가 미리 signed/salary_agreement_sent로 둔 상태),
// salaryAgreement 중첩 필드만 갱신한다.
export async function handleSubmitSalaryAgreementSignature(request, deps = {}) {
  const db = deps.firestore ?? getFirestore();
  const data = request?.data ?? {};

  const tokenId = textOf(data.tokenId);
  const signatureUrl = assertSignatureDataUrl(data.signatureUrl);
  const salaryPdfUrl = assertStorageUrlOrEmpty(data.salaryPdfUrl);
  const claimedContractId = textOf(data.contractId);

  const { token } = await loadValidToken(db, 'salaryAgreement', tokenId);
  const staffId = assertSafePathId(token.staffId, '급여 약정 정보');
  const contractId = assertSafePathId(token.contractId, '급여 약정 정보');
  if (claimedContractId && claimedContractId !== contractId) {
    throw new HttpsError('permission-denied', '급여 약정 정보가 일치하지 않습니다.');
  }

  const tokenRef = db.collection('salaryAgreementTokens').doc(tokenId);
  const contractRef = db.collection('staff').doc(staffId).collection('contracts').doc(contractId);

  await db.runTransaction(async (tx) => {
    const [tokenSnap, contractSnap] = await Promise.all([tx.get(tokenRef), tx.get(contractRef)]);
    if (!tokenSnap.exists || tokenSnap.data().status !== 'pending') {
      throw new HttpsError('failed-precondition', '이미 처리된 링크입니다.');
    }
    if (!contractSnap.exists) {
      throw new HttpsError('not-found', '계약서를 찾을 수 없습니다.');
    }
    if (!['signed', 'salary_agreement_sent'].includes(contractSnap.data().status)) {
      throw new HttpsError('failed-precondition', '급여 약정을 서명할 수 없는 상태입니다.');
    }

    const contractUpdate = {
      'salaryAgreement.status': 'signed',
      'salaryAgreement.signatureUrl': signatureUrl,
      'salaryAgreement.signedAt': FieldValue.serverTimestamp(),
      agreementTokenId: tokenId,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (salaryPdfUrl) contractUpdate.salaryPdfUrl = salaryPdfUrl;

    tx.update(contractRef, contractUpdate);
    tx.update(tokenRef, { status: 'signed', signedAt: FieldValue.serverTimestamp() });
  });

  return { ok: true, staffId, contractId };
}
