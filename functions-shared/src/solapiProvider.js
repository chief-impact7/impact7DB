import { SolapiMessageService } from 'solapi';
import { SOLAPI_API_KEY, SOLAPI_API_SECRET } from './solapiSecrets.js';

// 솔라피 자격증명 Secret 정의는 src/solapiSecrets.js로 분리(콜드스타트에 solapi SDK 미로드).
// index.js(T3 워커)가 함수 secrets에 바인딩한다.

// pfId(카카오 비즈니스 채널)는 비밀이 아니므로 설정값으로 고정.
export const SOLAPI_PF_ID = 'KA01PF260612092731139iFew1TZggoL';

// 운영 발신번호(02-2649-0509). 테스트(개인명의)는 SOLAPI_SENDER env로 override.
const DEFAULT_SENDER = '0226490509';

export function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function resolveSolapiSender() {
  return onlyDigits(process.env.SOLAPI_SENDER) || DEFAULT_SENDER;
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
    const res = await service.send(message, { showMessageList: true });
    return normalizeSuccess(res);
  } catch (err) {
    return normalizeFailure(err);
  }
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
