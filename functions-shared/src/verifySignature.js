// PG 웹훅 서명검증. 실제 알고리즘은 PG사 확정 후 구현.
// 지금은 인터페이스만 — 호출되면 미구현 표시.
export function verifyPaymentSignature(_rawBody, _signatureHeader, _secret) {
  throw new Error('verifyPaymentSignature: not implemented (PG사 확정 후)');
}
