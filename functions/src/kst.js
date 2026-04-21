// KST 기준 오늘 날짜 문자열 (YYYY-MM-DD).
// Cloud Functions 런타임은 UTC이므로 명시적 KST 변환 필수.
export function todayKST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}
