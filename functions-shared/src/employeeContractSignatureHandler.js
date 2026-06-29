import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { loadValidToken } from './hrPublicTokenHandler.js';
import { assertSafePathId } from './hrStorage.js';

// Task rules45 #4: 공개(비로그인) 근로계약서 서명 제출을 서버 callable로 이전.
// 기존 클라 플로우는 비인증 사용자가 staff/{id}.status='active'를 직접 write 했으나
// firestore.rules의 `allow write: if isDirector()`에 막혔다. Admin SDK(rules 우회)로
// 토큰을 검증한 뒤, 계약 서명 + 계약 status + staff.status='active' + 토큰 소진을
// 단일 트랜잭션으로 원자 갱신한다. 경로 ID는 토큰 doc에서만 도출(호출자 입력 무시).

const TOKEN_TYPE = 'employeeContractSigning';

function textOf(v) {
  return String(v ?? '').trim();
}

export async function handleSubmitEmployeeContractSignature(request, deps = {}) {
  const db = deps.firestore ?? getFirestore();
  const data = request?.data ?? {};

  const tokenId = textOf(data.tokenId);
  const signatureUrl = textOf(data.signatureUrl);
  const deviceInfo = textOf(data.deviceInfo);
  const claimedContractId = textOf(data.contractId);

  // 서명 이미지는 SignaturePad가 만드는 PNG/JPEG base64 data URL만 허용한다.
  // image/svg+xml은 렌더 시 스크립트 실행(저장형 XSS) 위험이 있어 raster만 허용하고, 길이도 제한한다.
  if (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(signatureUrl)
    || signatureUrl.length > 2_000_000) {
    throw new HttpsError('invalid-argument', '서명 이미지가 올바르지 않습니다.');
  }

  // 1) 토큰 검증(존재·미사용·미만료). tokenId 누락/오류는 loadValidToken이 throw.
  const { token } = await loadValidToken(db, TOKEN_TYPE, tokenId);
  // 경로 ID는 항상 토큰 doc에서 도출하고, traversal 방어로 형식 재검증한다.
  const employeeId = assertSafePathId(token.employeeId, '계약 정보');
  const contractId = assertSafePathId(token.contractId, '계약 정보');

  // contractId 바인딩: 호출자가 contractId를 보내면 토큰이 가리키는 계약과 일치해야 한다.
  if (claimedContractId && claimedContractId !== contractId) {
    throw new HttpsError('permission-denied', '계약 정보가 일치하지 않습니다.');
  }

  const tokenRef = db.collection('employeeContractSigningTokens').doc(tokenId);
  const staffRef = db.collection('staff').doc(employeeId);
  const contractRef = staffRef.collection('contracts').doc(contractId);

  // 2) 원자적 갱신 — 트랜잭션 내에서 토큰·계약 상태를 재확인(TOCTOU/이중 제출 차단).
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

    tx.update(contractRef, {
      'signatures.employee': {
        signatureUrl,
        signedAt: FieldValue.serverTimestamp(),
        deviceInfo,
      },
      status: 'signed',
      signingTokenId: tokenId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(staffRef, { status: 'active', updatedAt: FieldValue.serverTimestamp() });
    tx.update(tokenRef, { status: 'signed', signedAt: FieldValue.serverTimestamp() });
  });

  return { ok: true, employeeId, contractId };
}
