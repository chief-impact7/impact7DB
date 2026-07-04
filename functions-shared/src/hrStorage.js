import { randomUUID } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

// HR 파일 업로드/다운로드의 공통 저수준 유틸.
// 결정(H-01): 모든 HR 파일 접근은 callable이 역할/토큰을 서버에서 검증한 뒤 Admin SDK로 수행한다.
// 업로드는 base64를 받아 서버가 직접 write하므로 signed write URL이 불필요하고,
// 다운로드 URL은 Firebase download token을 파일 메타데이터에 심어 만든다.
// → 런타임 SA에 iam.serviceAccounts.signBlob(Token Creator) 권한 없이도 동작한다.
//   (getSignedUrl 방식은 signBlob 권한이 필요하므로 의도적으로 쓰지 않는다.)

// 업로드 허용 한도: PDF/이미지(서명 스캔·계약서)는 작으므로 20MB로 충분.
const MAX_BYTES = 20 * 1024 * 1024;
// base64는 원본보다 약 4/3 크므로, 디코드 전 문자열 길이도 같은 비율로 상한을 둔다(메모리 폭탄 방지).
const MAX_BASE64_LEN = Math.ceil(MAX_BYTES * 4 / 3) + 4;

// 클라이언트 contentType만 신뢰하지 않는다 — 매직넘버로 실제 바이트를 재검증한다.
const PDF_MAGIC = Buffer.from('%PDF-');
const IMAGE_MAGICS = [
  { type: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { type: 'image/jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  { type: 'image/gif', magic: Buffer.from([0x47, 0x49, 0x46, 0x38]) },
  { type: 'image/webp', magic: Buffer.from('RIFF') }, // RIFF....WEBP
];

function textOf(v) {
  return String(v ?? '').trim();
}

// 파일명 정규화 — HR 클라가 쓰던 동일 규칙(영숫자·._- 외 → _). path traversal 차단.
export function safeFileName(name) {
  const base = textOf(name).split('/').pop().split('\\').pop();
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'file';
}

// Firestore doc ID(영숫자·_-)만 허용. 경로 컴포넌트로 쓰는 ID는 정규화가 아니라 거부한다
// — '/','..',개행 등이 섞이면 임의 경로의 오브젝트를 만들 수 있으므로(IDOR/오염) fail-closed.
export function assertSafePathId(value, label) {
  const id = textOf(value);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new HttpsError('invalid-argument', `${label}가 올바르지 않습니다.`);
  }
  return id;
}

// 서명 이미지 검증 — SignaturePad가 만드는 raster PNG/JPEG base64 data URL만 허용한다.
// image/svg+xml은 렌더 시 스크립트 실행(저장형 XSS) 위험이 있어 raster만 허용한다.
// 서명은 계약 doc에 inline 저장되므로 Firestore 1MiB 문서 한도 아래(다른 필드 여유분 포함)로
// 크기를 제한하고, 오버사이즈 페이로드는 정규식 스캔 전에 먼저 거른다.
const SIGNATURE_DATA_URL = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;
const MAX_SIGNATURE_LEN = 900_000;
export function assertSignatureDataUrl(value) {
  const url = textOf(value);
  if (url.length > MAX_SIGNATURE_LEN || !SIGNATURE_DATA_URL.test(url)) {
    throw new HttpsError('invalid-argument', '서명 이미지가 올바르지 않습니다.');
  }
  return url;
}

// 서명 PDF URL 검증 — uploadSignedContractFile(writeFileWithDownloadUrl)가 만든 Firebase
// Storage 다운로드 URL만 허용한다. 비인증 서명자가 javascript:·data:·외부 피싱 URL을 계약
// doc에 심어 나중에 관리자가 여는 것을 차단. PDF 생성 실패 시 빈 값은 허용(서명만 저장).
const STORAGE_DOWNLOAD_URL_PREFIX = 'https://firebasestorage.googleapis.com/';
export function assertStorageUrlOrEmpty(value) {
  const url = textOf(value);
  if (url && !url.startsWith(STORAGE_DOWNLOAD_URL_PREFIX)) {
    throw new HttpsError('invalid-argument', '서명 문서 URL이 올바르지 않습니다.');
  }
  return url;
}

function startsWith(buf, magic) {
  if (buf.length < magic.length) return false;
  return buf.subarray(0, magic.length).equals(magic);
}

// 선언 contentType과 실제 바이트(매직넘버)를 모두 검증해 정규화된 MIME을 반환.
// PDF, image/* 만 허용. 불일치/미지원은 invalid-argument.
function detectAndValidateMime(buffer, declaredType) {
  const declared = textOf(declaredType).toLowerCase();

  if (startsWith(buffer, PDF_MAGIC)) {
    if (declared && declared !== 'application/pdf') {
      throw new HttpsError('invalid-argument', '파일 형식이 선언과 일치하지 않습니다.');
    }
    return 'application/pdf';
  }

  for (const { type, magic } of IMAGE_MAGICS) {
    if (!startsWith(buffer, magic)) continue;
    if (type === 'image/webp' && !buffer.subarray(8, 12).equals(Buffer.from('WEBP'))) continue;
    if (declared && declared !== type && !declared.startsWith('image/')) {
      throw new HttpsError('invalid-argument', '파일 형식이 선언과 일치하지 않습니다.');
    }
    return type;
  }

  throw new HttpsError('invalid-argument', 'PDF 또는 이미지 파일만 업로드할 수 있습니다.');
}

// base64(데이터 URL prefix 허용) → 검증된 Buffer + 정규화 contentType.
// 크기(문자열 길이·디코드 후 바이트)와 MIME(매직넘버)을 서버에서 모두 검증한다.
export function decodeAndValidate(dataBase64, declaredType) {
  const raw = textOf(dataBase64);
  if (!raw) throw new HttpsError('invalid-argument', '파일 데이터가 필요합니다.');

  // "data:application/pdf;base64,...." 형태면 헤더 제거.
  const comma = raw.indexOf(',');
  const payload = raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw;

  if (payload.length > MAX_BASE64_LEN) {
    throw new HttpsError('invalid-argument', '파일이 너무 큽니다(최대 20MB).');
  }

  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new HttpsError('invalid-argument', '파일 데이터를 디코드할 수 없습니다.');
  }
  if (buffer.length === 0) {
    throw new HttpsError('invalid-argument', '빈 파일은 업로드할 수 없습니다.');
  }
  if (buffer.length > MAX_BYTES) {
    throw new HttpsError('invalid-argument', '파일이 너무 큽니다(최대 20MB).');
  }

  const contentType = detectAndValidateMime(buffer, declaredType);
  return { buffer, contentType };
}

// Admin SDK로 파일을 쓰고, Firebase download token을 심어 client getDownloadURL()과
// 동일한 형태의 영구 다운로드 URL을 반환한다(signBlob 불필요).
// writeOnce=true면 같은 path가 이미 있을 때 거부한다 — 비로그인 서명 PDF는 토큰당 1회만
// 써야 하므로(덮어쓰기·리플레이 방지) 공개 업로드 경로에서 사용한다.
export async function writeFileWithDownloadUrl(bucket, path, buffer, contentType, { writeOnce = false } = {}) {
  const file = bucket.file(path);
  if (writeOnce) {
    const [exists] = await file.exists();
    if (exists) throw new HttpsError('already-exists', '이미 서명된 문서가 있습니다.');
  }
  const token = randomUUID();
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return { path, downloadUrl: buildDownloadUrl(bucket.name, path, token) };
}

// 기존 파일의 다운로드 URL 조회. 토큰이 없을 때:
//  - mintIfMissing=true(인증 직원 열람): 새 토큰을 발급해 메타데이터에 심는다.
//  - mintIfMissing=false(비로그인 토큰 열람): 새 영구 토큰을 만들지 않는다 — 미인증 호출자가
//    임의 파일에 불멸 URL을 찍는 것을 막는다(없으면 not-found).
// 토큰 read/patch에 signBlob은 필요 없다(메타데이터만 사용).
export async function getOrCreateDownloadUrl(bucket, path, { mintIfMissing = true } = {}) {
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', '파일을 찾을 수 없습니다.');

  const [meta] = await file.getMetadata();
  const existing = textOf(meta?.metadata?.firebaseStorageDownloadTokens).split(',')[0];
  if (existing) {
    return { path, downloadUrl: buildDownloadUrl(bucket.name, path, existing) };
  }
  if (!mintIfMissing) {
    throw new HttpsError('not-found', '다운로드할 수 있는 문서가 없습니다.');
  }

  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  return { path, downloadUrl: buildDownloadUrl(bucket.name, path, token) };
}

function buildDownloadUrl(bucketName, path, token) {
  const encoded = encodeURIComponent(path);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}
