// 홍보(광고) 수신 정책 게이트 — promo 경로 전용. 정보성 출결 알림(동의 불요)과 절대 섞지 않는다.
//
// 도달 경로별 수신 근거가 다르다:
//  - 브랜드 메시지(BMS): 카카오 채널 친구 여부로 도달이 결정된다(친구 목록을 우리가 모르므로 발송 시도로 판정).
//    채널 추가 자체가 카카오 약관상 수신 자격이라, 우리 쪽 별도 게이트는 두지 않는다.
//  - 광고 SMS 대체발송: 정보통신망법상 명시적 수신동의가 필요하다 → canReceivePromoSms 게이트로만 허용.
//
// students/{id}.message_consent.promo 구조:
//  { optedIn: boolean, at: Timestamp, source: 'kakao_friend'|'diagnostic_form'|'admin',
//    night: boolean, revokedAt: Timestamp|null }

export function getPromoConsent(student) {
  return student?.message_consent?.promo ?? null;
}

// 광고 SMS 대체발송 허용 여부: 동의했고 철회하지 않은 경우만.
// (브랜드 메시지 자체는 채널 친구 근거로 발송하며 이 게이트를 거치지 않는다.)
export function canReceivePromoSms(student) {
  const c = getPromoConsent(student);
  return !!(c && c.optedIn === true && !c.revokedAt);
}

// 캠페인 대상 산출 시 분류 사유. 발송 스킵을 카운트/감사하기 위한 라벨.
export function promoEligibility(student) {
  const c = getPromoConsent(student);
  if (!c || c.optedIn !== true) return { smsFallbackAllowed: false, reason: 'no_consent' };
  if (c.revokedAt) return { smsFallbackAllowed: false, reason: 'revoked' };
  return { smsFallbackAllowed: true, reason: null };
}
