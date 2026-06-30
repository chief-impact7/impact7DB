import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

// 키오스크 전용 허용 계정 — 학원 도메인 계정이 없는 태블릿 단말 로그인용.
// 출결/직원출퇴근 callable에만 허용한다(알림톡·LLM 등 민감 기능은 학원 도메인 전용).
const KIOSK_EMAILS = new Set(['impact7eng@gmail.com']);

// 직원 계정(학원 도메인) 판정 — 보안 경계는 항상 callable 서버측이다.
// allowKiosk=true면 키오스크 전용 계정도 허용한다.
export function isAuthorizedStaffEmail(email, { allowKiosk = false } = {}) {
  const e = (email || '').toLowerCase();
  if (/@(gw\.)?impact7\.kr$/i.test(e)) return true;
  return allowKiosk && KIOSK_EMAILS.has(e);
}

// callable 공통 가드: 로그인 + 학원 도메인 + (명시적 미인증 차단).
// email_verified는 Workspace 토큰엔 항상 존재하나, 명시적으로 false일 때만 거부한다.
// allowKiosk=true면 키오스크 전용 계정도 통과한다(태블릿 출결 callable 한정).
export function assertAuthorizedStaff(auth, { allowKiosk = false } = {}) {
  if (!auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  const token = auth.token || {};
  if (token.email_verified === false || !isAuthorizedStaffEmail(token.email, { allowKiosk })) {
    throw new HttpsError('permission-denied', '허용되지 않은 계정입니다.');
  }
}

// 원장급(owner/principal) 판정 — firestore.rules의 isDirector()와 동일 소스(HR_users/{uid}.role).
// 새 권한 체계를 만들지 않고 기존 역할 컬렉션을 그대로 읽는다. 비용·외부발송이 걸린 변경에 사용.
export async function assertDirector(auth, db) {
  assertAuthorizedStaff(auth);
  const firestore = db || getFirestore();
  const snap = await firestore.collection('HR_users').doc(auth.uid).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'owner' && role !== 'principal') {
    throw new HttpsError('permission-denied', '원장 권한이 필요합니다.');
  }
}

// 관리자급 이상(owner/principal/manager) 판정 — firestore.rules의 isDirector()||isManager()와 동일 소스.
// 근태 보정처럼 director 미만이라도 manager가 수행해야 하는 작업에 사용. (assertDirector보다 한 단계 넓다.)
export async function assertManagerOrAbove(auth, db) {
  assertAuthorizedStaff(auth);
  const firestore = db || getFirestore();
  const snap = await firestore.collection('HR_users').doc(auth.uid).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'owner' && role !== 'principal' && role !== 'manager') {
    throw new HttpsError('permission-denied', '관리자 권한이 필요합니다.');
  }
}
