// 광고 야간 발송 제한(KST 20:50~익일 08:00) 대응. 제한시간에 광고 발송 요청이 들어오면
// 솔라피 자동 보류에 의존하지 않고, 우리가 다음 08:00 KST로 예약(scheduledDate)을 명시한다.
// 정보성 메시지(알림톡/출결)는 야간 제한이 없으므로 이 보정을 적용하지 않는다.
//
// 시각 계산은 UTC 절대시각(Date)을 KST 벽시계로 환산해서 수행한다(서버 TZ에 의존하지 않음).

const AD_NIGHT_START_MIN = 20 * 60 + 50; // 20:50
const AD_MORNING_MIN = 8 * 60; // 08:00

function kstParts(date) {
  const k = new Date(date.getTime() + 9 * 3600_000); // KST 벽시계를 UTC getter로 읽기
  return {
    y: k.getUTCFullYear(),
    mo: k.getUTCMonth() + 1,
    d: k.getUTCDate(),
    h: k.getUTCHours(),
    mi: k.getUTCMinutes(),
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 'YYYY-MM-DD HH:mm[:ss]' (KST 벽시계) → UTC 절대시각 Date. 형식 불일치 시 null.
export function parseKstToDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 9, +mi));
}

// KST 기준 광고 발송 제한시간(20:50~익일 08:00)인가.
export function isAdNightKST(now) {
  const { h, mi } = kstParts(now);
  const cur = h * 60 + mi;
  return cur >= AD_NIGHT_START_MIN || cur < AD_MORNING_MIN;
}

// 광고 발송 예약시각 보정.
//  - 주간(08:00~20:49): null 반환 → 즉시 발송.
//  - 새벽(00:00~07:59): 당일 08:00.
//  - 저녁(20:50~23:59): 익일 08:00.
// 반환 형식은 솔라피 scheduledDate용 KST 문자열 'YYYY-MM-DD HH:mm:ss'.
export function resolveAdScheduledAt(now) {
  const { y, mo, d, h, mi } = kstParts(now);
  const cur = h * 60 + mi;
  if (cur >= AD_MORNING_MIN && cur < AD_NIGHT_START_MIN) return null; // 주간 → 즉시

  let ty = y;
  let tmo = mo;
  let td = d;
  if (cur >= AD_NIGHT_START_MIN) {
    // 저녁 → 익일 08:00 (KST 자정 기준 +1일을 UTC 산술로 안전 계산)
    const next = new Date(Date.UTC(y, mo - 1, d) + 24 * 3600_000);
    ty = next.getUTCFullYear();
    tmo = next.getUTCMonth() + 1;
    td = next.getUTCDate();
  }
  return `${ty}-${pad(tmo)}-${pad(td)} 08:00:00`;
}
