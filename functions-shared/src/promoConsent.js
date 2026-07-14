// 홍보(광고) 수신 정책 게이트 — promo 경로 전용. 정보성 출결 알림(동의 불요)과 절대 섞지 않는다.
//
// 광고 문자는 정보통신망법상 명시적 수신동의가 필요하다 → canReceivePromoSms 게이트로만 허용.
//
// 동의는 번호 주인(수신자) 단위다 — 학부모 번호와 학생 번호의 동의를 분리한다:
//  students/{id}.message_consent.promo         = 보호자(학부모) 동의 (기존 필드, 진단평가 신청서 체크)
//  students/{id}.message_consent.promo_student = 학생 본인 동의
// 구조: { optedIn: boolean, at: Timestamp, source: 'kakao_friend'|'diagnostic_form'|'survey_form'|'admin',
//         revokedAt: Timestamp|null }

const CONSENT_FIELD = { parent: 'promo', student: 'promo_student' };

// 발송 수신 필드 → 동의 대상. 학생 본인 번호만 학생 동의, 나머지(학부모1/2·기타)는 보호자 동의.
export function consentTargetOf(recipientField) {
  return recipientField === 'student' ? 'student' : 'parent';
}

export function promoConsentField(target) {
  return CONSENT_FIELD[target] ?? CONSENT_FIELD.parent;
}

export function getPromoConsent(student, target = 'parent') {
  return student?.message_consent?.[promoConsentField(target)] ?? null;
}

// 광고 문자 허용 여부: 해당 대상이 동의했고 철회하지 않은 경우만.
export function canReceivePromoSms(student, target = 'parent') {
  const c = getPromoConsent(student, target);
  return !!(c && c.optedIn === true && !c.revokedAt);
}

// 캠페인 대상 산출 시 분류 사유. 발송 스킵을 카운트/감사하기 위한 라벨.
export function promoEligibility(student, target = 'parent') {
  const c = getPromoConsent(student, target);
  if (!c || c.optedIn !== true) return { smsFallbackAllowed: false, reason: 'no_consent' };
  if (c.revokedAt) return { smsFallbackAllowed: false, reason: 'revoked' };
  return { smsFallbackAllowed: true, reason: null };
}
