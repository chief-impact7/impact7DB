// ISO 8601 주차(week) 키 — board_briefings 문서 ID(`{board}_{week}`)에 쓰는 순수 헬퍼.
// 입력은 KST 벽시계 날짜 문자열('YYYY-MM-DD', 보통 @impact7/shared/datetime의 todayKST() 결과).
// UTC 산술로만 계산해 함수 실행 서버의 로컬 타임존과 무관하게 항상 같은 결과를 낸다.
export function isoWeekKST(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoDay = (date.getUTCDay() + 6) % 7; // 월=0 ... 일=6
  date.setUTCDate(date.getUTCDate() - isoDay + 3); // 그 주의 목요일 — ISO 연도 귀속 기준일

  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstIsoDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIsoDay + 3);

  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
