import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { assertAuthorizedStaff } from './authGuards.js';

// 홍보 광고 수신동의 설정/철회(옵트아웃) callable.
// 동의 출처는 진단평가신청서·관리자 입력 등(설계 §7.2). 철회 시 revokedAt을 남겨
// 이후 캠페인 대상 산출(canReceivePromoSms)에서 영구 제외된다.
// 동의 입력/철회는 직원(학원 도메인)이 수행. 실제 광고 발송은 원장 권한(createPromoCampaign).

const VALID_SOURCES = new Set(['kakao_friend', 'diagnostic_form', 'admin']);

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

  const promo = buildPromoConsentPatch({ optedIn: data.optedIn, source: data.source });
  await db.collection('students').doc(studentId).set(
    { message_consent: { promo, updated_by: request.auth?.uid ?? null } },
    { merge: true },
  );
  return { studentId, optedIn: promo.optedIn, source: promo.source };
}
