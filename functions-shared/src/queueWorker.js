import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { maskPhone } from './phoneMask.js';
import { resolveChannelAddUrl, channelInviteSuffix, loadChannelInviteText } from './channelInvite.js';
import { parseKstToDate } from './promoSchedule.js';

// 메시지 큐 워커 — 계약 정본(message-architect_api-contract §2.4, §4.1) 기준.
// status 전이: pending → processing → sent | failed_retryable | failed_permanent.
// fallback(SMS/LMS)은 솔라피 내장 대체발송이므로 워커는 SMS를 따로 보내지 않고
// 솔라피 최종 채널(message_logs.channel)만 기록한다.

// BMS 발송결과 "수신 완료"(친구 도달) 코드 — message_logs 기록용. 접수(2000)는 카톡 도달이
// 아니므로 비친구(3120)·야간(3108)은 발송결과 폴링에서 판정한다(코드 정본은 solapiProvider.js).
const BMS_DELIVERED_CODE = '4000';
const SMS_DELIVERED_CODE = '4000'; // SMS/LMS 수신 완료 — direct/promo_sms 발송결과 확정용
// 발송결과 폴링 파라미터: parent_bms 접수 후 도달/비친구가 확정되기까지 사후 조회한다.
const DELIVERY_FIRST_DELAY_MS = 2 * 60_000; // 접수 후 첫 결과 조회까지 대기(2분)
const DELIVERY_RECHECK_MS = 2 * 60_000; // 미확정 시 재조회 간격(2분)
const DELIVERY_LEASE_MS = 3 * 60_000; // 폴링 클레임 리스(중복 조회 방지) — 스케줄 주기(1분)보다 크게
const MAX_DELIVERY_CHECKS = 15; // 재조회 상한(약 30분) — 초과 시 안전하게 문자 전환
const DELIVERY_SWEEP_LIMIT = 200; // 폴링 1회 처리 상한(대량 발송 시 함수 타임아웃 방지)

// 전화번호에서 숫자만 추출 — solapiProvider.onlyDigits와 동일 규칙.
// 정적 import 금지(콜드스타트 F7 계약)로 여기에 인라인으로 둔다.
const onlyDigitsLocal = (value) => String(value ?? '').replace(/\D/g, '');

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000]; // 1m, 5m, 15m
const LEASE_MS = 10 * 60_000; // processing 리스(10분) — 크래시로 고착된 doc을 sweeper가 회수
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 종결 doc 평문 PII 보존기간(7일) — 이후 purge(T8 항목1)
const PURGE_LIMIT = 500; // purge 1회 처리 상한(폭주 방지)
// 정보성(attendance/parent_notice)은 알림톡, 홍보(promo)는 브랜드 메시지로 발송.
// promo는 P3 캠페인 callable이 동의 게이트·야간 보정을 통과시킨 뒤에만 enqueue되므로,
// 워커는 큐 doc의 disable_sms/scheduled_date를 그대로 provider에 전달한다(여기서 재검증 안 함).
const ALLOWED_KINDS = new Set(['attendance', 'parent_notice', 'promo', 'direct', 'report', 'promo_sms', 'parent_bms']);
const PROMO_KIND = 'promo';
const REPORT_KIND = 'report'; // 일일 학습 리포트 — 정보형 BMS(친구만 수신, 비친구는 발송 단계에서 가입안내로 분기)
const PARENT_BMS_KIND = 'parent_bms'; // 학부모 안내(진단평가 등) — 정보형 BMS, report와 동일 동작
const PROMO_SMS_KIND = 'promo_sms'; // 비친구 광고동의자 → 광고 SMS 직접 발송(BMS 대체 비활성 우회)
// 종결 후 purge 대상 평문 필드(번호·대체발송 본문·학생명 포함 변수맵).
const PII_FIELDS = ['recipient_phone', 'fallback_text', 'template_variables'];

// 솔라피 호출은 T2(solapiProvider.js)에 위임. 정적 import를 피해 — 파일/시크릿 바인딩이
// 준비되기 전에도 워커·테스트가 로드되게 하고, 실제 발송 시점에만 동적 로드한다.
// getSolapiConfig()는 함수 실행 컨텍스트(시크릿 바인딩 상태)에서만 secret .value()가 유효하므로
// 발송 직전에 호출해 sendKakaoAlimtalk(payload, config)로 넘긴다. 테스트는 deps.sender로 대체.
async function defaultSender(payload) {
  const mod = await import('./solapiProvider.js');
  const config = mod.getSolapiConfig();
  if (payload.kind === PROMO_KIND || payload.kind === REPORT_KIND || payload.kind === PARENT_BMS_KIND) return mod.sendKakaoBrandMessage(payload, config);
  if (payload.kind === 'direct' || payload.kind === PROMO_SMS_KIND) return mod.sendSms(payload, config);
  return mod.sendKakaoAlimtalk(payload, config);
}

// 발송결과 사후 조회기(폴링). 접수≠도달이므로 groupId로 최종 발송결과를 조회한다.
// SMS(direct/promo_sms)와 BMS는 결과 코드 의미가 달라 조회 함수를 kind로 분기한다.
async function defaultResultFetcher(groupId, kind) {
  const mod = await import('./solapiProvider.js');
  const config = mod.getSolapiConfig();
  if (kind === 'direct' || kind === PROMO_SMS_KIND) return mod.fetchSmsResult(groupId, config);
  return mod.fetchBrandMessageResult(groupId, config);
}

// result_callback이 있으면 종결 직후 OIDC POST로 수신 시스템에 알린다.
// audience = url로 Google IdToken을 발급받아 Authorization: Bearer 헤더로 전달한다.
async function defaultNotifyResultCallback(url, body) {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(url);
  await client.request({ url, method: 'POST', data: body });
}

// 콜백 실패는 큐 처리 결과에 영향 없음 — try/catch로 격리하고 에러만 기록한다.
async function fireResultCallback(notify, ref, data, { status, channel }) {
  const resultCallback = data.result_callback;
  if (!resultCallback) return;
  const body = {
    applicationId: resultCallback.applicationId,
    status,
    channel: channel ?? null,
    queueId: ref.id,
    at: new Date().toISOString(),
  };
  try {
    await notify(resultCallback.url, body);
  } catch (err) {
    console.error('[queueWorker] result_callback 호출 실패:', err?.message ?? err);
  }
}

// 로그 저장용 마스킹 — 평문 번호 저장 금지(계약 §2.5). 공용 maskPhone(src/phoneMask.js) 사용.

// 큐 doc → provider payload. kind별로 provider 입력이 다르다(알림톡=템플릿, promo=자유 본문).
function buildSendPayload(data) {
  if (data.kind === 'direct' || data.kind === PROMO_SMS_KIND) {
    return {
      to: data.recipient_phone,
      text: data.content ?? '',
      scheduledDate: data.scheduled_date ?? undefined,
      kind: data.kind,
    };
  }
  if (data.kind === PROMO_KIND) {
    return {
      to: data.recipient_phone,
      content: data.content ?? '',
      buttons: data.buttons ?? undefined,
      imageId: data.image_id ?? undefined,
      adFlag: data.ad_flag !== false, // 광고 기본 true
      disableSms: data.disable_sms !== false, // 동의자만 P3가 false로 세팅(미동의면 BMS만)
      targeting: data.targeting ?? 'M',
      scheduledDate: data.scheduled_date ?? undefined, // 야간 보정된 예약시각(있으면)
      kind: data.kind,
    };
  }
  if (data.kind === REPORT_KIND || data.kind === PARENT_BMS_KIND) {
    return {
      to: data.recipient_phone,
      content: data.content ?? '',
      adFlag: data.ad_flag === true, // 정보형 기본 false
      disableSms: true, // 비친구는 발송결과 폴링이 문자로 전환 — 솔라피 내장 대체는 BMS에서 비활성
      targeting: data.targeting ?? 'I',
      scheduledDate: data.scheduled_date ?? undefined, // 예약시각 있으면 전달(parent_bms는 야간 시 dispatch가 08:00 보정)
      kind: data.kind,
    };
  }
  return {
    to: data.recipient_phone,
    templateCode: data.template_code,
    templateVariables: data.template_variables ?? {},
    fallbackText: data.fallback_text ?? '',
    kind: data.kind,
  };
}

// pending→processing(또는 failed_retryable/processing→processing) CAS 클레임.
// 다른 워커/sweeper가 이미 가져갔으면 null 반환 → 중복 처리 방지.
// processing 전이 시 next_attempt_at을 now+LEASE_MS(리스)로 설정한다. 발송 직후 markSent/
// markRetry/markPermanent가 이를 덮어쓰지만, 그 전에 크래시하면 리스 만료 후 sweeper가 회수한다.
// attempt_count는 여기서 증가시키지 않으므로(클레임된 data의 attempt_count 그대로 dispatch에 전달)
// 회수·재발송해도 이중 카운트되지 않는다.
async function claimForProcessing(db, ref, expectedStatus) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.status !== expectedStatus) return null;
    tx.update(ref, {
      status: 'processing',
      next_attempt_at: new Date(Date.now() + LEASE_MS),
      updated_at: FieldValue.serverTimestamp(),
    });
    return data;
  });
}

async function writeMessageLog(db, data, queueId, fields) {
  await db.collection('message_logs').add({
    queue_id: queueId,
    checkin_id: data.checkin_id ?? null,
    student_id: data.student_id ?? null,
    staff_id: data.staff_id ?? null, // 직원 출퇴근 알림은 staff_id로 발송 로그 추적(학생 payload엔 없어 null)
    kind: data.kind ?? null,
    provider: 'solapi',
    channel: fields.channel ?? null,
    solapi_message_id: fields.messageId ?? null,
    solapi_group_id: fields.groupId ?? null,
    status: fields.status,
    status_code: fields.statusCode ?? null,
    error_message: fields.message ?? null,
    request_summary: {
      template_code: data.template_code ?? null,
      recipient_masked: maskPhone(data.recipient_phone),
    },
    created_at: FieldValue.serverTimestamp(),
  });
}

async function markSent(db, ref, data, result) {
  await ref.update({
    status: 'sent',
    attempt_count: (data.attempt_count ?? 0) + 1,
    next_attempt_at: null,
    sent_attempt_at: FieldValue.delete(), // 발송 시도 종결 — 크래시 마커 해제
    last_error_code: null,
    purge_after: new Date(Date.now() + RETENTION_MS), // 종결 → 보존기간 후 평문 PII purge
    updated_at: FieldValue.serverTimestamp(),
  });
  await writeMessageLog(db, data, ref.id, {
    status: 'sent',
    channel: result.channel,
    statusCode: result.statusCode,
    messageId: result.messageId,
    groupId: result.groupId,
  });
}

async function markRetry(db, ref, nextAttempt, statusCode) {
  const backoff = BACKOFF_MS[Math.min(nextAttempt - 1, BACKOFF_MS.length - 1)];
  await ref.update({
    status: 'failed_retryable',
    attempt_count: nextAttempt,
    next_attempt_at: new Date(Date.now() + backoff),
    // provider가 실패를 반환한 경우 — 재시도는 새 시도로 취급해 마커 해제.
    // 한계: NetworkError(응답 유실)는 솔라피가 접수했을 수도 있어 재시도가 중복 발송이 될 수
    // 있으나, 이를 전부 수동 검토로 돌리면 일시 네트워크 오류마다 발송이 멈춘다 — at-least-once
    // 트레이드오프로 수용. 근본 해소는 솔라피 멱등키 지원 확인 후.
    sent_attempt_at: FieldValue.delete(),
    last_error_code: statusCode ?? null,
    updated_at: FieldValue.serverTimestamp(),
  });
  // 재시도는 로그 남기지 않는다(계약 §4.1: sent/failed_permanent만 message_logs 기록).
}

async function markPermanent(db, ref, data, nextAttempt, fields) {
  await ref.update({
    status: 'failed_permanent',
    attempt_count: nextAttempt,
    next_attempt_at: null,
    sent_attempt_at: FieldValue.delete(),
    delivery_check_at: null, // awaiting에서 영구실패로 종결 시 폴링 잔여 필드 정리(다른 경로엔 무해)
    last_error_code: fields.statusCode ?? null,
    purge_after: new Date(Date.now() + RETENTION_MS), // 종결 → 보존기간 후 평문 PII purge
    updated_at: FieldValue.serverTimestamp(),
  });
  await writeMessageLog(db, data, ref.id, {
    status: 'failed',
    channel: fields.channel ?? null,
    statusCode: fields.statusCode,
    message: fields.message,
    messageId: null,
    groupId: null,
  });
}

// 클레임된 큐 doc 1건 발송 시도 + 결과 반영.
async function dispatch(db, ref, data, sender, notifyResultCallback, now = new Date()) {
  // kind 경계(T8 항목3): 정보성(attendance/parent_notice)만 이 워커로 발송한다.
  // promo 등이 출결 큐를 재사용해 동의 게이트 없이 나가는 것을 차단 — 발송 없이 영구 종결.
  if (!ALLOWED_KINDS.has(data.kind)) {
    await markPermanent(db, ref, data, (data.attempt_count ?? 0) + 1, {
      statusCode: 'kind_not_allowed',
      message: `허용되지 않은 kind: ${data.kind ?? '(none)'} — promo는 별도 동의 게이트 필요`,
      channel: null,
    });
    await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel: null });
    return;
  }

  // 정보형 BMS는 야간(20:50~08:00)엔 카카오가 발송을 차단(실측 3108)한다. parent_bms는 예약시각이
  // 없으면 자동으로 다음 08:00로 보정해 솔라피 예약 발송에 맡긴다. report(교사 수동)는 자동 보정 대신
  // 발송자가 명시 예약(scheduled_date, 야간 안내 시 UI에서 선택)한 경우에만 그 시각으로 예약하고,
  // 예약이 없으면 즉시 시도해 야간차단(3108)이 나오면 발송결과 폴링이 문자로 전환한다.
  let scheduledSendAt = null;
  if (data.kind === PARENT_BMS_KIND || data.kind === REPORT_KIND) {
    const { isAdNightKST, resolveAdScheduledAt, parseKstToDate } = await import('./promoSchedule.js');
    if (data.kind === PARENT_BMS_KIND && !data.scheduled_date && isAdNightKST(now)) {
      data.scheduled_date = resolveAdScheduledAt(now);
    }
    if (data.scheduled_date) scheduledSendAt = parseKstToDate(data.scheduled_date);
  }

  // 발송 직전 마커 — 이 이후 크래시하면 솔라피 접수 여부가 불확실하다. sweeper가 리스 회수 시
  // 이 마커를 보고 자동 재발송 대신 수동 검토(failed_permanent)로 종결해 중복 발송을 차단한다.
  await ref.update({ sent_attempt_at: FieldValue.serverTimestamp() });

  // provider는 예외를 던지지 않지만, 방어적 catch 경로는 일시적 미상 오류로 재시도 취급한다.
  let result;
  try {
    result = await sender(buildSendPayload(data));
  } catch (err) {
    result = { ok: false, retryable: true, statusCode: null, channel: null, errorMessage: String(err?.message || err) };
  }

  if (result?.ok) {
    // 정보형 BMS(parent_bms/report) 접수 성공(2000)은 카톡 도달을 보장하지 않는다 — 비친구(3120)·
    // 야간(3108)은 비동기 발송결과에만 나타난다. 따라서 종결하지 않고 발송결과 폴링이 도달/비친구를
    // 확정한다(친구 학습·문자 전환·콜백은 모두 폴링 단계로 미룬다). report도 친구명단이 실제 카톡
    // 상태와 어긋날 수 있어(명단엔 있으나 미도달) 동일하게 폴링해 미도달 시 문자로 전환한다.
    if (data.kind === PARENT_BMS_KIND || data.kind === REPORT_KIND) {
      // 예약 발송이면 발송 시각 이후부터 결과를 조회한다(즉시 발송이면 접수 시각 기준). 예약 전
      // 조기 폴링이 미발송을 'pending'으로 누적해 상한 타임아웃으로 오전환되는 것을 막는다.
      const base = scheduledSendAt && scheduledSendAt > now ? scheduledSendAt : now;
      await markAwaitingDeliveryResult(db, ref, data, result, new Date(base.getTime() + DELIVERY_FIRST_DELAY_MS));
      return;
    }
    if ((data.kind === 'direct' || data.kind === PROMO_SMS_KIND) && result.groupId) {
      // SMS/LMS 접수 성공(2000)도 통신사 도달을 보장하지 않는다(예: 3058 "전송경로 없음"은
      // 비동기 발송결과에만 나타남). 종결하지 않고 발송결과 폴링이 도달/실패를 확정한다.
      // groupId가 없으면 사후조회가 불가능(매번 missing_group_id로 읽혀 중복 재발송 유발)하므로
      // 폴링에 넣지 않고 아래에서 기존처럼 즉시 종결한다.
      await markAwaitingDeliveryResult(db, ref, data, result, new Date(now.getTime() + DELIVERY_FIRST_DELAY_MS));
      return;
    }
    await markSent(db, ref, data, result);
    await fireResultCallback(notifyResultCallback, ref, data, { status: 'sent', channel: result.channel });
    return;
  }

  // 접수 단계 실패(잘못된 번호/템플릿/네트워크 등). 비친구·야간은 접수=2000이라 여기 오지 않는다.
  // 재시도 판정 정본은 provider의 result.retryable(불리언). statusCode 파싱하지 않는다.
  const statusCode = result?.statusCode ?? null;
  const message = result?.errorMessage ?? null;
  const channel = result?.channel ?? null;
  const retryable = !!result?.retryable;
  const nextAttempt = (data.attempt_count ?? 0) + 1;

  if (retryable && nextAttempt < MAX_ATTEMPTS) {
    await markRetry(db, ref, nextAttempt, statusCode);
  } else {
    await markPermanent(db, ref, data, nextAttempt, { statusCode, message, channel });
    await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel });
  }
}

// parent_bms 접수 성공 → 발송결과 대기. 도달/비친구는 발송결과 폴링이 확정한다.
async function markAwaitingDeliveryResult(db, ref, data, result, checkAt) {
  await ref.update({
    status: 'awaiting_delivery_result',
    attempt_count: (data.attempt_count ?? 0) + 1,
    sent_attempt_at: FieldValue.delete(), // 접수 확인됨 — 크래시 마커 해제(이후는 폴링이 확정)
    scheduled_date: data.scheduled_date ?? null, // 야간 보정값 영속화 — 폴링·문자전환이 참조
    solapi_group_id: result.groupId ?? null,
    solapi_message_id: result.messageId ?? null,
    delivery_check_at: checkAt,
    delivery_check_count: 0,
    next_attempt_at: null,
    last_error_code: null,
    updated_at: FieldValue.serverTimestamp(),
  });
  // 접수 단계 로그는 남기지 않는다 — 최종 결과 확정 시 message_logs 1건(sent/converted/failed).
}

// 카톡 도달 확정(4000): 종결 + 친구 학습 + 콜백(channel=kakao).
async function finalizeBmsDelivered(db, ref, data, notifyResultCallback) {
  await ref.update({
    status: 'sent',
    delivery_check_at: null,
    purge_after: new Date(Date.now() + RETENTION_MS),
    updated_at: FieldValue.serverTimestamp(),
  });
  try {
    const phoneKey = onlyDigitsLocal(data.recipient_phone);
    if (phoneKey) {
      await db.collection('kakao_channel_friends').doc(phoneKey).set(
        { phone: phoneKey, updated_at: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }
  } catch (err) {
    console.error('[queueWorker] 친구 학습 실패(발송 영향 없음):', err?.message ?? err);
  }
  await writeMessageLog(db, data, ref.id, { status: 'sent', channel: 'kakao', statusCode: BMS_DELIVERED_CODE });
  await fireResultCallback(notifyResultCallback, ref, data, { status: 'sent', channel: 'kakao' });
}

// SMS/LMS 도달 확정(4000): 종결 + 로그(channel=sms). BMS와 달리 친구 학습은 없다(카카오 미경유).
async function finalizeSmsDelivered(db, ref, data, notifyResultCallback) {
  await ref.update({
    status: 'sent',
    delivery_check_at: null,
    purge_after: new Date(Date.now() + RETENTION_MS),
    updated_at: FieldValue.serverTimestamp(),
  });
  await writeMessageLog(db, data, ref.id, { status: 'sent', channel: 'sms', statusCode: SMS_DELIVERED_CODE });
  await fireResultCallback(notifyResultCallback, ref, data, { status: 'sent', channel: 'sms' });
}

// SMS 통신사 미도달 → 같은 번호로 재발송 예약(failed_retryable). attempt_count는 awaiting 진입 시
// 이미 증가했으므로 여기서 올리지 않는다(폴링 진입마다 1씩 누적 → MAX_ATTEMPTS에서 종료). retrySweeper가
// 백오프 후 재발송하고, 그 결과는 다시 발송결과 폴링이 확정한다.
async function markSmsRetry(db, ref, attemptCount, statusCode) {
  const backoff = BACKOFF_MS[Math.min(attemptCount - 1, BACKOFF_MS.length - 1)];
  await ref.update({
    status: 'failed_retryable',
    next_attempt_at: new Date(Date.now() + backoff),
    delivery_check_at: null, // awaiting 폴링 필드 정리(재발송 후 다시 설정됨)
    last_error_code: statusCode ?? null,
    updated_at: FieldValue.serverTimestamp(),
  });
}

const BMS_NOT_FRIEND_CODE = '3120'; // solapiProvider.BMS_NOT_FRIEND_CODE — 정적 import 금지(F7)로 인라인.

// 비친구(3120) 확정으로 문자 전환할 때, 원문 뒤에 채널 가입 유도를 덧붙인다 — 큐 doc이 커스텀
// 문구(sms_suffix)를 주면 그것을, 없으면 기본 유도를 자동으로 붙인다. 친구톡 본문(content)은 그대로
// 두므로 채널 가입자(친구톡 도달)에겐 노출되지 않는다. 야간차단(3108)·미확정 타임아웃은 비친구 확정이
// 아니라(친구여도 못 받았을 수 있음) 부가문구 없이 원문만 전환한다.
function smsFallbackContent(data, statusCode, inviteText) {
  const base = data.content ?? '';
  if (statusCode === BMS_NOT_FRIEND_CODE) {
    const suffix = data.sms_suffix ?? inviteText ?? channelInviteSuffix(resolveChannelAddUrl());
    if (suffix) return base + '\n\n' + suffix;
  }
  return base;
}

// 카톡 미도달(비친구 3120 / 야간 3108 / 장시간 미확정) → 친구명단 제거 + 문자(direct) 전환 doc 생성
// + 원 doc 종결. fallback doc 생성과 원본 종결을 batch로 원자화한다(H-08): batch 실패 시 원본은
// 이전 상태로 남아 sweeper가 재처리(유실·split-brain 방지). 콜백은 문자 doc 처리 시 1회(channel=sms).
async function convertBmsToSms(db, ref, data, statusCode, attemptCount, now = new Date()) {
  try {
    const phoneKey = onlyDigitsLocal(data.recipient_phone);
    if (phoneKey) await db.collection('kakao_channel_friends').doc(phoneKey).delete();
  } catch (err) {
    console.error('[queueWorker] 친구명단 제거 실패(전환 계속):', err?.message ?? err);
  }
  // 채널 가입 유도 문구 — 운영자 설정(message_settings) 우선, 없으면 기본(SSOT: channelInvite.js).
  const inviteText = data.sms_suffix ?? await loadChannelInviteText(db);
  const smsDocId = ref.id + '_sms';
  // 전환 문자는 즉시 발송한다 — 폴링은 예약시각 이후에만 돌므로 원본 scheduled_date는 보통
  // 지난 시각이고, 복사하면 솔라피가 재예약해 안내가 또 지연된다(2026-07-04 사고). 미래만 유지.
  const scheduledAt = parseKstToDate(data.scheduled_date);
  const batch = db.batch();
  batch.set(db.collection('message_queue').doc(smsDocId), {
    kind: 'direct',
    status: 'pending',
    recipient_phone: data.recipient_phone,
    student_id: data.student_id ?? null, // 수신자별 이력 타임라인이 전환 문자도 잡도록 승계
    content: smsFallbackContent(data, statusCode, inviteText),
    scheduled_date: scheduledAt && scheduledAt > now ? data.scheduled_date : null,
    attempt_count: 0,
    created_by: 'bms_fallback',
    created_at: FieldValue.serverTimestamp(),
    result_callback: data.result_callback ?? null,
  });
  batch.update(ref, {
    status: 'converted_to_sms',
    attempt_count: attemptCount,
    next_attempt_at: null,
    delivery_check_at: null,
    last_error_code: statusCode,
    purge_after: new Date(Date.now() + RETENTION_MS),
    updated_at: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  await writeMessageLog(db, data, ref.id, {
    status: 'converted_to_sms',
    channel: null,
    statusCode,
    message: '비친구/미도달 → SMS 전환',
  });
}

// awaiting_delivery_result doc 클레임 — delivery_check_at을 리스만큼 미래로 밀어 중복 조회를 막는다.
async function claimDeliveryCheck(db, ref, now) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const d = snap.data();
    if (d.status !== 'awaiting_delivery_result') return null;
    if (d.delivery_check_at && d.delivery_check_at > now) return null;
    tx.update(ref, {
      delivery_check_at: new Date(now.getTime() + DELIVERY_LEASE_MS),
      updated_at: FieldValue.serverTimestamp(),
    });
    return d;
  });
}

// 클레임된 awaiting doc 1건의 발송결과를 조회해 종결/전환/재연장한다.
async function processDeliveryResult(db, ref, data, resultFetcher, notifyResultCallback, now) {
  const result = await resultFetcher(data.solapi_group_id, data.kind);
  const count = (data.delivery_check_count ?? 0) + 1;
  const attemptCount = data.attempt_count ?? 0;
  const isSms = data.kind === 'direct' || data.kind === PROMO_SMS_KIND;

  switch (result?.outcome) {
    case 'delivered':
      if (isSms) await finalizeSmsDelivered(db, ref, data, notifyResultCallback);
      else await finalizeBmsDelivered(db, ref, data, notifyResultCallback);
      return;
    case 'not_friend':
    case 'night_blocked':
      // BMS 전용 결과 — SMS 발송결과에선 나오지 않는다.
      await convertBmsToSms(db, ref, data, result.statusCode, attemptCount, now);
      return;
    case 'failed':
      // SMS 통신사 미도달(예: 3058)은 일시적일 수 있어 상한까지 재발송, 이후 영구 실패로 종결.
      if (isSms && attemptCount < MAX_ATTEMPTS) {
        await markSmsRetry(db, ref, attemptCount, result.statusCode);
      } else {
        await markPermanent(db, ref, data, attemptCount, { statusCode: result.statusCode, message: result.statusMessage, channel: isSms ? 'sms' : null });
        await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel: isSms ? 'sms' : null });
      }
      return;
    default: // 'pending' 또는 미상 — 재조회. 상한 초과 시 유실 방지 처리(BMS=문자전환, SMS=미확정 종결).
      if (count >= MAX_DELIVERY_CHECKS) {
        if (!isSms) {
          await convertBmsToSms(db, ref, data, 'delivery_result_timeout', attemptCount, now);
        } else {
          // SMS 접수 성공분은 도달했을 공산이 크다(결과 미수신 ≠ 발송 실패). 재발송은 중복 위험이
          // 있으므로 재발송 없이 미확정으로 종결한다. (명시적 failed(예: 3058)만 재발송 대상.)
          await markPermanent(db, ref, data, attemptCount, { statusCode: 'delivery_result_timeout', message: '발송결과 미확정', channel: 'sms' });
          await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel: 'sms' });
        }
      } else {
        await ref.update({
          delivery_check_count: count,
          delivery_check_at: new Date(now.getTime() + DELIVERY_RECHECK_MS),
          updated_at: FieldValue.serverTimestamp(),
        });
      }
      return;
  }
}

// onDocumentCreated('message_queue/{id}') 단발 처리.
export async function processQueueDoc(event, deps = {}) {
  const db = deps.db ?? getFirestore();
  const sender = deps.sender ?? defaultSender;
  const notifyResultCallback = deps.notifyResultCallback ?? defaultNotifyResultCallback;
  const now = deps.now ?? new Date();
  const ref = event?.data?.ref ?? db.collection('message_queue').doc(event.params.id);
  const claimed = await claimForProcessing(db, ref, 'pending');
  if (!claimed) return null; // 이미 처리됐거나 중복 트리거
  await dispatch(db, ref, claimed, sender, notifyResultCallback, now);
  return null;
}

// onSchedule(짧은 주기, 예 1분) 발송결과 폴링 — parent_bms 접수 후 도달/비친구를 확정한다.
// awaiting_delivery_result & delivery_check_at<=now 대상: getGroupMessages로 결과 조회 →
// 도달(4000) 종결+친구학습, 비친구(3120)/야간(3108) 문자 전환, 미확정 재연장(상한 후 문자).
export async function runDeliveryResultSweep(deps = {}) {
  const db = deps.db ?? getFirestore();
  const resultFetcher = deps.resultFetcher ?? defaultResultFetcher;
  const notifyResultCallback = deps.notifyResultCallback ?? defaultNotifyResultCallback;
  const now = deps.now ?? new Date();

  const snap = await db.collection('message_queue')
    .where('status', '==', 'awaiting_delivery_result')
    .where('delivery_check_at', '<=', now)
    .orderBy('delivery_check_at') // 오래 대기한 doc 우선 — 대량 발송 시 굶주림 방지
    .limit(DELIVERY_SWEEP_LIMIT)
    .get();

  let processed = 0;
  for (const doc of snap.docs) {
    const claimed = await claimDeliveryCheck(db, doc.ref, now);
    if (!claimed) continue; // 다른 sweeper가 선점 또는 아직 대기
    await processDeliveryResult(db, doc.ref, claimed, resultFetcher, notifyResultCallback, now);
    processed += 1;
  }
  return { processed };
}

// onSchedule 5분 주기 sweeper — 재시도 시각/리스 도래분 재투입.
// 대상: failed_retryable(백오프 도래) + processing(리스 만료 = 크래시 고착) 중 next_attempt_at<=now.
// equality-in(status) + range(next_attempt_at)는 기존 (status, next_attempt_at) 복합 인덱스로 커버된다.
export async function runRetrySweep(deps = {}) {
  const db = deps.db ?? getFirestore();
  const sender = deps.sender ?? defaultSender;
  const notifyResultCallback = deps.notifyResultCallback ?? defaultNotifyResultCallback;
  const now = deps.now ?? new Date();

  const snap = await db.collection('message_queue')
    .where('status', 'in', ['failed_retryable', 'processing'])
    .where('next_attempt_at', '<=', now)
    .get();

  let processed = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if ((data.attempt_count ?? 0) >= MAX_ATTEMPTS) continue; // 상한 초과분은 sweeper가 건드리지 않음
    // 실제 status로 CAS — 그 사이 다른 워커가 종결/회수했으면 null로 건너뛴다.
    const claimed = await claimForProcessing(db, doc.ref, data.status);
    if (!claimed) continue; // 다른 워커가 선점
    // 크래시 고착 회수분 중 발송 직전 마커(sent_attempt_at)가 남은 doc은 솔라피 접수 여부가
    // 불확실하다 — 자동 재발송하면 학부모가 같은 메시지를 2번 받을 수 있어 수동 검토로 종결.
    // (마커 없는 processing = provider 호출 전 크래시 → 안전하게 자동 재발송)
    if (data.status === 'processing' && claimed.sent_attempt_at) {
      await markPermanent(db, doc.ref, claimed, (claimed.attempt_count ?? 0) + 1, {
        statusCode: 'crash_after_dispatch',
        message: '발송 접수 후 결과 기록 전 중단 — 중복 발송 방지를 위해 자동 재발송하지 않음. 발송실패 관리에서 솔라피 발송내역 확인 후 수동 재발송.',
        channel: null,
      });
      await fireResultCallback(notifyResultCallback, doc.ref, claimed, { status: 'failed', channel: null });
      processed += 1;
      continue;
    }
    await dispatch(db, doc.ref, claimed, sender, notifyResultCallback, now);
    processed += 1;
  }
  return { processed };
}

// 종결(sent/failed_permanent) doc의 평문 PII를 보존기간 경과 후 제거(T8 항목1).
// purge_after(단일필드 range, 자동 인덱스)로 도래분만 조회 → 평문 필드 삭제, 마스킹 참조만 남김.
// 큐 doc 자체는 보존(status·타임스탬프·id·attempt 감사용) — message_logs와 함께 audit 유지.
export async function purgeExpiredPii(deps = {}) {
  const db = deps.db ?? getFirestore();
  const now = deps.now ?? new Date();

  const snap = await db.collection('message_queue')
    .where('purge_after', '<=', now)
    .limit(PURGE_LIMIT)
    .get();

  let purged = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const patch = {
      recipient_masked: maskPhone(data.recipient_phone), // 평문 삭제 전 마스킹 참조 보존
      purge_after: FieldValue.delete(),                  // 재선정 방지
      pii_purged_at: FieldValue.serverTimestamp(),
    };
    for (const field of PII_FIELDS) patch[field] = FieldValue.delete();
    await doc.ref.update(patch);
    purged += 1;
  }
  return { purged };
}

export const __testing = { maskPhone, buildSendPayload, ALLOWED_KINDS, PII_FIELDS, RETENTION_MS, MAX_ATTEMPTS, BACKOFF_MS };
