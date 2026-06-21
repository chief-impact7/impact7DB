import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertDirector } from './authGuards.js';
import { loadValidToken } from './hrPublicTokenHandler.js';
import {
  decodeAndValidate,
  safeFileName,
  assertSafePathId,
  writeFileWithDownloadUrl,
  getOrCreateDownloadUrl,
} from './hrStorage.js';

// H-01: 모든 HR 파일 접근을 callable 경유로 옮기는 서버 골격.
// - 업로드는 base64를 받아 서버가 크기·MIME을 검증한 뒤 Admin SDK로 write(서명 write URL 불필요).
// - write 경로 ID(staffId/ownerId/contractId)는 절대 호출자 입력을 그대로 쓰지 않는다:
//   인증 업로드는 역할 게이트 후 staffId만 경로에 쓰고, 공개 업로드는 토큰 doc에서 ID를 도출한다.

function textOf(v) {
  return String(v ?? '').trim();
}

function bucketOf(deps) {
  return deps.bucket ?? getStorage().bucket();
}

// 공개 서명 업로드가 다루는 계약 토큰 타입만 허용. 다른 토큰 타입은 거부한다.
const SIGN_TOKEN_TYPES = new Set(['contractSigning', 'employeeContractSigning', 'salaryAgreement']);
const CONTRACT_PDF_TYPES = new Set(['contract', 'salary']);

// === 1) 인증 직원: 직원 문서 업로드 → staff/{staffId}/documents/{ts}_{safeName} ===
// 비용/PII가 걸린 파일 쓰기이므로 원장급 게이트(assertDirector). request.data로 staffId만 받고
// fileName은 정규화한다. 반환 downloadUrl은 클라가 Firestore documents 서브컬렉션에 저장한다.
export async function handleHrUploadStaffDocument(request, deps = {}) {
  const db = deps.firestore ?? getFirestore();
  await assertDirector(request.auth, db);

  const data = request.data ?? {};
  const staffId = assertSafePathId(data.staffId, 'staffId');

  const { buffer, contentType } = decodeAndValidate(data.dataBase64, data.contentType);
  const safeName = safeFileName(data.fileName);
  const path = `staff/${staffId}/documents/${Date.now()}_${safeName}`;

  return writeFileWithDownloadUrl(bucketOf(deps), path, buffer, contentType);
}

// === 2) 인증 관리자: 계약서 PDF 업로드 → contracts/{ownerId}/{contractId}/{type}_signed.pdf ===
// 관리자 화면(contracts/[id])에서 서명 완료 후 PDF를 발송할 때 호출. 원장급 게이트.
// ownerId/contractId는 인증된 관리자가 다루는 자기 테넌트 데이터이므로 입력을 신뢰하되 정규화한다.
export async function handleHrUploadContract(request, deps = {}) {
  const db = deps.firestore ?? getFirestore();
  await assertDirector(request.auth, db);

  const data = request.data ?? {};
  const ownerId = assertSafePathId(data.ownerId, 'ownerId');
  const contractId = assertSafePathId(data.contractId, 'contractId');
  const type = textOf(data.type);
  if (!CONTRACT_PDF_TYPES.has(type)) {
    throw new HttpsError('invalid-argument', 'type은 contract 또는 salary여야 합니다.');
  }

  const { buffer, contentType } = decodeAndValidate(data.pdfBase64, 'application/pdf');
  if (contentType !== 'application/pdf') {
    throw new HttpsError('invalid-argument', '계약서는 PDF만 업로드할 수 있습니다.');
  }
  const path = `contracts/${ownerId}/${contractId}/${type}_signed.pdf`;
  return writeFileWithDownloadUrl(bucketOf(deps), path, buffer, contentType);
}

// === 3) 공개(비로그인) 서명자: 서명 PDF 업로드 → contracts/{ownerId}/{contractId}/{type}_signed.pdf ===
// HR-13 수정: 비로그인 서명자는 storage isAuthorized()에 막혀 PDF 업로드가 조용히 실패했다.
// 토큰을 검증(존재·미사용·미만료)하고 ownerId/contractId를 토큰 doc에서 도출(호출자 입력 무시)해 쓴다.
export async function handleHrUploadSignedContract(request, deps = {}) {
  const db = deps.firestore ?? getFirestore();
  const data = request.data ?? {};
  const tokenType = textOf(data.tokenType);
  const tokenId = textOf(data.tokenId);
  const type = textOf(data.type);

  if (!SIGN_TOKEN_TYPES.has(tokenType)) {
    throw new HttpsError('invalid-argument', '지원하지 않는 tokenType입니다.');
  }
  if (!CONTRACT_PDF_TYPES.has(type)) {
    throw new HttpsError('invalid-argument', 'type은 contract 또는 salary여야 합니다.');
  }

  const { token } = await loadValidToken(db, tokenType, tokenId);

  // ID는 항상 토큰 doc에서 — employee 계약은 employeeId가 owner. 토큰 doc 값도 경로 안전성 재검증.
  const ownerId = assertSafePathId(token.employeeId || token.staffId, '계약 정보');
  const contractId = assertSafePathId(token.contractId, '계약 정보');

  const { buffer, contentType } = decodeAndValidate(data.pdfBase64, 'application/pdf');
  if (contentType !== 'application/pdf') {
    throw new HttpsError('invalid-argument', '서명 문서는 PDF만 업로드할 수 있습니다.');
  }
  // 토큰당 1회만 — 같은 서명 PDF 덮어쓰기/리플레이 차단(미인증 경로).
  const path = `contracts/${ownerId}/${contractId}/${type}_signed.pdf`;
  return writeFileWithDownloadUrl(bucketOf(deps), path, buffer, contentType, { writeOnce: true });
}

// === 4) 다운로드 URL 발급 (단명 read URL 대체 — Firebase download token 기반) ===
// 두 게이트를 지원한다:
//  - 인증(staff 문서·contracts 관리자 열람): assertDirector.
//  - 공개 토큰(서명자가 방금 올린 자기 계약 PDF 열람): contracts/{ownerId}/{contractId}/ 하위만 허용.
// path는 화이트리스트(staff/{id}/... 또는 contracts/{ownerId}/{contractId}/...)로 제한해 임의 경로 열람을 막는다.
export async function handleHrGetFileUrl(request, deps = {}) {
  const db = deps.firestore ?? getFirestore();
  const data = request.data ?? {};
  const path = textOf(data.path);
  if (!path) throw new HttpsError('invalid-argument', 'path가 필요합니다.');

  const tokenType = textOf(data.tokenType);
  const tokenId = textOf(data.tokenId);

  if (tokenType || tokenId) {
    // 공개 토큰 게이트: 토큰을 검증하고, 토큰이 가리키는 계약 경로의 파일만 허용.
    if (!SIGN_TOKEN_TYPES.has(tokenType)) {
      throw new HttpsError('invalid-argument', '지원하지 않는 tokenType입니다.');
    }
    const { token } = await loadValidToken(db, tokenType, tokenId);
    const ownerId = assertSafePathId(token.employeeId || token.staffId, '계약 정보');
    const contractId = assertSafePathId(token.contractId, '계약 정보');
    const allowedPrefix = `contracts/${ownerId}/${contractId}/`;
    if (!path.startsWith(allowedPrefix)) {
      throw new HttpsError('permission-denied', '이 파일에 접근할 수 없습니다.');
    }
    // 미인증 호출자는 기존 토큰만 받는다 — 새 영구 토큰을 찍지 못하게 한다.
    return getOrCreateDownloadUrl(bucketOf(deps), path, { mintIfMissing: false });
  }

  // 인증 게이트: 원장급만. HR 파일 경로(staff/ 또는 contracts/)만 허용.
  await assertDirector(request.auth, db);
  if (!path.startsWith('staff/') && !path.startsWith('contracts/')) {
    throw new HttpsError('invalid-argument', '허용되지 않은 파일 경로입니다.');
  }
  return getOrCreateDownloadUrl(bucketOf(deps), path);
}
