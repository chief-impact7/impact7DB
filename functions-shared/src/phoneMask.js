// 전화번호 표시·로그용 단일 마스킹 함수. 저장 포맷과 표시 포맷을 '***-****-뒤4자리'로 통일한다.
// queueWorker(로그/purge 시 recipient_masked 저장)와 messageDeliveryHandler(실패 목록 표시)가
// 같은 함수를 쓰므로 재마스킹·형식 불일치가 발생하지 않는다.
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return `***-****-${digits.slice(-4)}`;
}
