import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';
import { promoConsentField } from './promoConsent.js';

// 홍보 광고 수신동의 설정/철회(옵트아웃) callable.
// 동의 출처는 진단평가신청서·관리자 입력 등(설계 §7.2). 철회 시 revokedAt을 남겨
// 이후 캠페인 대상 산출(canReceivePromoSms)에서 영구 제외된다.
// 동의는 번호 주인 단위 — target: 'parent'(기본, 보호자)|'student'(학생 본인)로 필드를 분리한다.
// 동의 입력/철회는 직원(학원 도메인)이 수행. 실제 광고 발송은 원장 권한(createPromoCampaign).

const VALID_SOURCES = new Set(['kakao_friend', 'diagnostic_form', 'survey_form', 'admin']);
const VALID_TARGETS = new Set(['parent', 'student']);

// students/{id}.message_consent.promo 패치 생성. optedIn=false면 옵트아웃(revokedAt 기록).
export function buildPromoConsentPatch({ optedIn, source }) {
  const src = VALID_SOURCES.has(source) ? source : 'admin';
  const on = optedIn === true;
  return {
    optedIn: on,
    source: src,
    at: FieldValue.serverTimestamp(),
    revokedAt: on ? null : FieldValue.serverTimestamp(),
  };
}

export async function handleSetPromoConsent(request, deps = {}) {
  const db = deps.db ?? getFirestore();
  assertAuthorizedStaff(request.auth);

  const data = request.data ?? {};
  const studentId = String(data.studentId ?? '').trim();
  if (!studentId) throw new HttpsError('invalid-argument', 'studentId가 필요합니다.');
  if (typeof data.optedIn !== 'boolean') {
    throw new HttpsError('invalid-argument', 'optedIn(boolean)이 필요합니다.');
  }

  const target = VALID_TARGETS.has(data.target) ? data.target : 'parent';
  const promo = buildPromoConsentPatch({ optedIn: data.optedIn, source: data.source });
  await db.collection('students').doc(studentId).set(
    { message_consent: { [promoConsentField(target)]: promo, updated_by: request.auth?.uid ?? null } },
    { merge: true },
  );
  return { studentId, target, optedIn: promo.optedIn, source: promo.source };
}
