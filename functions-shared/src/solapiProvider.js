import { SolapiMessageService } from 'solapi';
import { SOLAPI_API_KEY, SOLAPI_API_SECRET } from './solapiSecrets.js';
import { parseKstToDate } from './promoSchedule.js';

// 솔라피 자격증명 Secret 정의는 src/solapiSecrets.js로 분리(콜드스타트에 solapi SDK 미로드).
// index.js(T3 워커)가 함수 secrets에 바인딩한다.

// pfId(카카오 비즈니스 채널)는 비밀이 아니므로 설정값으로 고정.
export const SOLAPI_PF_ID = 'KA01PF260612092731139iFew1TZggoL';

// 운영 발신번호(02-2649-0509) 고정. 번호 변경은 이 상수로 한다.
const DEFAULT_SENDER = '0226490509';

export function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function resolveSolapiSender() {
  // SOLAPI_SENDER env override는 배포 환경에 옛 값이 잔존해 잘못된 번호로 발송되는 사고가
  // 있어 제거했다. 항상 운영 발신번호를 쓴다.
  return DEFAULT_SENDER;
}

// 워커(T3)가 호출. firebase 함수 실행 컨텍스트에서만 secret .value() 접근 가능.
export function getSolapiConfig() {
  return {
    apiKey: SOLAPI_API_KEY.value(),
    apiSecret: SOLAPI_API_SECRET.value(),
    pfId: SOLAPI_PF_ID,
    from: resolveSolapiSender(),
  };
}

function defaultServiceFactory(apiKey, apiSecret) {
  return new SolapiMessageService(apiKey, apiSecret);
}

// 카카오 알림톡 발송(내장 SMS/LMS 대체발송 허용). 예외를 던지지 않고
// T3 워커가 큐/로그에 그대로 매핑할 수 있는 정규화 결과를 반환한다.
//
// payload: { to, templateCode, templateVariables(또는 variables), fallbackText }
// config:  { apiKey, apiSecret, pfId, from }. 생략 시 getSolapiConfig()로 자동 해석
//          (워커가 config 없이 호출 가능 — 단 함수 export에 secrets 바인딩 필요).
// 반환:    { ok, retryable, channel, messageId, groupId, statusCode, errorMessage }
//   - retryable: 재시도 판정 정본(불리언). 워커는 이 값으로 분기한다.
//                true → 네트워크/5xx/rate limit(sweeper 재시도), false → 영구 실패.
//   - statusCode: ok:false면 항상 채워진다(솔라피 코드/HTTP 상태/오류 태그). 로그·last_error_code용.
//   - channel: 접수 시점에는 'kakao'(ATA). 알림톡→SMS/LMS 최종 대체 여부는 발송 후 별도 조회로 확정
export async function sendKakaoAlimtalk(payload, config, { serviceFactory = defaultServiceFactory } = {}) {
  const cfg = config ?? getSolapiConfig();
  const to = onlyDigits(payload?.to);
  if (!to) return permanentResult('invalid_recipient', '수신번호가 비어 있습니다.');
  if (!payload?.templateCode) return permanentResult('missing_template', '템플릿 코드가 없습니다.');

  const message = {
    to,
    from: onlyDigits(cfg?.from),
    kakaoOptions: {
      pfId: cfg?.pfId,
      templateId: payload.templateCode,
      variables: payload.templateVariables ?? payload.variables ?? {},
      disableSms: false, // 내장 대체발송(SMS/LMS) 허용
    },
  };
  if (payload.fallbackText) message.text = payload.fallbackText; // 대체발송 본문

  try {
    const service = serviceFactory(cfg.apiKey, cfg.apiSecret);
    const res = await service.send(message, buildSendOptions(payload));
    return normalizeSuccess(res);
  } catch (err) {
    return normalizeFailure(err);
  }
}

// BMS_FREE는 운영에서 사용하지 않는다. 자유 본문은 SMS/LMS 또는 승인된 알림톡 템플릿만 허용한다.
export async function sendKakaoBrandMessage(payload, config, { serviceFactory = defaultServiceFactory } = {}) {
  void payload;
  void config;
  void serviceFactory;
  return permanentResult('bms_free_disabled', 'BMS_FREE 발송은 비활성화되었습니다. 자유 본문은 SMS/LMS 또는 승인 알림톡 템플릿을 사용하세요.');
}

// 일반 SMS/LMS 발송(카카오 미경유) — 임의 번호 즉석 발송용. 본문 길이에 따라 솔라피가 SMS/LMS 자동 분류.
// 예외 없이 정규화 결과를 반환(워커가 큐/로그에 매핑). 접수 성공 시 channel은 'sms'.
// payload: { to, text, scheduledDate? }
export async function sendSms(payload, config, { serviceFactory = defaultServiceFactory } = {}) {
  const cfg = config ?? getSolapiConfig();
  const to = onlyDigits(payload?.to);
  if (!to) return permanentResult('invalid_recipient', '수신번호가 비어 있습니다.');
  if (!payload?.text) return permanentResult('missing_text', 'SMS 본문이 비어 있습니다.');

  const message = { to, from: onlyDigits(cfg?.from), text: payload.text };
  try {
    const service = serviceFactory(cfg.apiKey, cfg.apiSecret);
    const res = await service.send(message, buildSendOptions(payload));
    const result = normalizeSuccess(res);
    return result.ok ? { ...result, channel: 'sms' } : result;
  } catch (err) {
    return normalizeFailure(err);
  }
}

// BMS 최종 발송결과 코드(getGroupMessages 메시지 statusCode) — 접수(send의 2000)와 별개.
// 비친구(3120)·야간(3108)은 동기 send 응답엔 없고 비동기 발송결과에만 나타나므로,
// 워커가 발송 후 이 결과를 사후 조회해 친구톡 도달/문자 전환을 확정한다.
export const BMS_DELIVERED_CODE = '4000'; // 수신 완료(친구 도달)
export const BMS_NOT_FRIEND_CODE = '3120'; // 비친구/72h 미사용 — 카톡 미도달(문자 전환 대상)
export const BMS_NIGHT_BLOCKED_CODE = '3108'; // 야간 발송제한(20:50~08:00) — 정보형 BMS도 차단됨

// SMS/LMS 최종 발송결과 코드(getGroupMessages). 4000=수신완료. 비-4000은 통신사 미도달
// (예: 3058 전송경로 없음 — 일시적일 수 있어 워커가 재발송 상한까지 재시도). 카카오 미경유라
// BMS의 친구/야간 분기는 없다.
export const SMS_DELIVERED_CODE = '4000'; // 수신 완료

// 발송 후 솔라피 발송결과를 조회한다. 예외를 던지지 않고 정규화 결과를 반환한다.
// 반환: { outcome: 'delivered'|'not_friend'|'night_blocked'|'pending'|'failed', statusCode, statusMessage }
//   - pending: 아직 발송 진행 중이거나 조회가 일시 실패 — 워커가 재조회(상한 관리).
export async function fetchBrandMessageResult(groupId, config, { serviceFactory = defaultServiceFactory } = {}) {
  if (!groupId) return { outcome: 'failed', statusCode: 'missing_group_id', statusMessage: 'groupId가 비어 있습니다.' };
  const cfg = config ?? getSolapiConfig();
  try {
    const service = serviceFactory(cfg.apiKey, cfg.apiSecret);
    const res = await service.getGroupMessages(groupId);
    return normalizeGroupResult(res);
  } catch (err) {
    // 조회 실패는 일시적 오류일 수 있으므로 pending(재조회) — 워커가 재시도 상한을 관리한다.
    return { outcome: 'pending', statusCode: errorStatusCode(err), statusMessage: errorMessageText(err) };
  }
}

// getGroupMessages 응답에서 건당 첫 메시지 결과를 추출. 결과 없으면 null(호출자가 pending 처리).
function firstGroupMessage(res) {
  const list = res?.messageList ?? {};
  const items = Array.isArray(list) ? list : Object.values(list);
  if (!items.length) return null;
  const m = items[0]; // 건당 1발송 — 방어적으로 첫 메시지 기준
  return { code: String(m.statusCode ?? ''), status: String(m.status ?? ''), statusMessage: m.reason ?? m.statusMessage ?? null };
}

function normalizeGroupResult(res) {
  const m = firstGroupMessage(res);
  if (!m) return { outcome: 'pending', statusCode: 'no_messages', statusMessage: '발송결과 미생성' };
  const { code, status, statusMessage } = m;
  if (code === BMS_DELIVERED_CODE) return { outcome: 'delivered', statusCode: code, statusMessage };
  if (code === BMS_NOT_FRIEND_CODE) return { outcome: 'not_friend', statusCode: code, statusMessage };
  if (code === BMS_NIGHT_BLOCKED_CODE) return { outcome: 'night_blocked', statusCode: code, statusMessage };
  if (status && status !== 'COMPLETE') return { outcome: 'pending', statusCode: code || status, statusMessage };
  return { outcome: 'failed', statusCode: code || 'unknown', statusMessage };
}

// 발송 후 SMS/LMS 발송결과를 조회한다(direct/promo_sms). 예외를 던지지 않고 정규화 결과를 반환한다.
// 반환: { outcome: 'delivered'|'failed'|'pending', statusCode, statusMessage }
//   - delivered: 4000 수신 완료. failed: 비-4000(통신사 미도달). pending: 발송 진행중/조회 일시실패.
export async function fetchSmsResult(groupId, config, { serviceFactory = defaultServiceFactory } = {}) {
  if (!groupId) return { outcome: 'failed', statusCode: 'missing_group_id', statusMessage: 'groupId가 비어 있습니다.' };
  const cfg = config ?? getSolapiConfig();
  try {
    const service = serviceFactory(cfg.apiKey, cfg.apiSecret);
    const res = await service.getGroupMessages(groupId);
    return normalizeSmsGroupResult(res);
  } catch (err) {
    // 조회 실패는 일시적 오류일 수 있으므로 pending(재조회) — 워커가 재시도 상한을 관리한다.
    return { outcome: 'pending', statusCode: errorStatusCode(err), statusMessage: errorMessageText(err) };
  }
}

function normalizeSmsGroupResult(res) {
  const m = firstGroupMessage(res);
  if (!m) return { outcome: 'pending', statusCode: 'no_messages', statusMessage: '발송결과 미생성' };
  const { code, status, statusMessage } = m;
  if (code === SMS_DELIVERED_CODE) return { outcome: 'delivered', statusCode: code, statusMessage };
  if (status && status !== 'COMPLETE') return { outcome: 'pending', statusCode: code || status, statusMessage };
  return { outcome: 'failed', statusCode: code || 'unknown', statusMessage };
}

// 솔라피 send 옵션. scheduledDate가 있으면 예약 발송(솔라피가 보관 후 지정 시각 발송).
// 광고 야간 제한 대응은 호출자가 resolveAdScheduledAt(promoSchedule.js)로 시각을 보정해 넘긴다.
// scheduled_date 계약은 KST 벽시계 문자열 — 타임존 없는 문자열을 그대로 넘기면 솔라피가
// UTC로 해석해 9시간 늦게 예약된다(2026-07-04 진단평가 야간보정 사고). UTC ISO로 변환해 넘긴다.
function buildSendOptions(payload) {
  const options = { showMessageList: true };
  const at = payload?.scheduledDate instanceof Date
    ? payload.scheduledDate
    : parseKstToDate(payload?.scheduledDate);
  if (at) options.scheduledDate = at.toISOString();
  return options;
}

function normalizeSuccess(res) {
  const groupInfo = res?.groupInfo ?? {};
  // count 객체가 명시적으로 존재할 때만 registeredSuccess===0을 실패로 본다.
  // count 자체가 없는 부분/축약 응답은 실패로 단정하지 않고 접수 간주(아래 count_missing).
  const hasCount = groupInfo.count != null && typeof groupInfo.count === 'object';
  const count = hasCount ? groupInfo.count : {};
  const groupId = groupInfo.groupId ?? null;
  const messageId = res?.messageList?.[0]?.messageId ?? null;
  const statusCode =
    res?.messageList?.[0]?.statusCode ??
    res?.failedMessageList?.[0]?.statusCode ??
    groupInfo.status ??
    null;

  // 접수 성공 0건이면 영구 실패(번호/템플릿 거부 등). 솔라피는 전건 실패 시 throw하지만
  // 부분 응답/접수 0건도 방어한다. statusCode는 항상 채운다(로그·last_error_code용).
  if (hasCount && num(count.registeredSuccess) < 1) {
    return {
      ok: false,
      retryable: false,
      channel: null,
      messageId,
      groupId,
      statusCode: statusCode ?? 'registered_zero',
      errorMessage: res?.failedMessageList?.[0]?.statusMessage || '발송 접수 실패(registeredSuccess=0)',
    };
  }

  return {
    ok: true,
    retryable: false,
    channel: 'kakao',
    messageId,
    groupId,
    // count 누락 시 접수 간주 — 카운트 부재를 statusCode로 표시(로그 추적용).
    statusCode: hasCount ? statusCode : (statusCode ?? 'count_missing'),
    errorMessage: null,
  };
}

function normalizeFailure(err) {
  return {
    ok: false,
    retryable: isRetryable(err),
    channel: null,
    messageId: err?.failedMessageList?.[0]?.messageId ?? null,
    groupId: null,
    statusCode: errorStatusCode(err),
    errorMessage: errorMessageText(err),
  };
}

// 재시도 가능 분류: 네트워크 오류, 5xx 서버 오류, 429 rate limit만 재시도.
// 그 외(잘못된 요청/번호/템플릿/변수/인증/접수 거부)는 영구 실패.
function isRetryable(err) {
  switch (err?._tag) {
    case 'NetworkError':
      return err?.isRetryable !== false;
    case 'ServerError':
      return true;
    case 'ClientError':
      return num(err?.httpStatus) === 429;
    default:
      return false;
  }
}

// ok:false면 항상 비어있지 않은 코드를 반환한다(워커 로그·last_error_code가 의존).
// 실코드(HTTP 상태/솔라피 statusCode/errorCode)가 없으면 오류 _tag를 센티넬로 쓴다.
function errorStatusCode(err) {
  if (err?.httpStatus != null) return String(err.httpStatus);
  const failed = err?.failedMessageList?.[0];
  if (failed?.statusCode) return String(failed.statusCode);
  if (err?.errorCode) return String(err.errorCode);
  if (err?._tag) return String(err._tag);
  return 'unknown_error';
}

function errorMessageText(err) {
  if (!err) return 'unknown error';
  const failed = err?.failedMessageList?.[0];
  const tag = err._tag ?? 'Error';
  if (failed?.statusMessage) return `${tag}: ${failed.statusMessage}`;
  return String(err.message ?? err.errorMessage ?? err);
}

function permanentResult(statusCode, errorMessage) {
  return {
    ok: false,
    retryable: false,
    channel: null,
    messageId: null,
    groupId: null,
    statusCode,
    errorMessage,
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
