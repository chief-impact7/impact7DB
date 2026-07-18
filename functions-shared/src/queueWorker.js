import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { maskPhone } from './phoneMask.js';
import { parseKstToDate } from './promoSchedule.js';
import { applyMessageVars, hasVarTokens } from './bulkMessageHandler.js';

// 메시지 큐 워커 — 계약 정본(message-architect_api-contract §2.4, §4.1) 기준.
// status 전이: pending → processing → sent | failed_retryable | failed_permanent.
// 알림톡 외 자유 본문은 SMS/LMS provider로 통일한다.

const SMS_DELIVERED_CODE = '4000'; // SMS/LMS 수신 완료 — direct/promo_sms 발송결과 확정용
// 발송결과 폴링 파라미터: SMS/LMS 접수 후 통신사 도달이 확정되기까지 사후 조회한다.
const DELIVERY_FIRST_DELAY_MS = 2 * 60_000; // 접수 후 첫 결과 조회까지 대기(2분)
const DELIVERY_RECHECK_MS = 2 * 60_000; // 미확정 시 재조회 간격(2분)
const DELIVERY_LEASE_MS = 3 * 60_000; // 폴링 클레임 리스(중복 조회 방지) — 스케줄 주기(1분)보다 크게
const MAX_DELIVERY_CHECKS = 15; // 재조회 상한(약 30분)
const DELIVERY_SWEEP_LIMIT = 200; // 폴링 1회 처리 상한(대량 발송 시 함수 타임아웃 방지)

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000]; // 1m, 5m, 15m
const LEASE_MS = 10 * 60_000; // processing 리스(10분) — 크래시로 고착된 doc을 sweeper가 회수
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 종결 doc 평문 PII 보존기간(7일) — 이후 purge(T8 항목1)
const PURGE_LIMIT = 500; // purge 1회 처리 상한(폭주 방지)
// attendance/parent_notice/bulk_alimtalk은 알림톡, 자유 본문은 문자로 발송.
const KAKAO_KINDS = new Set(['attendance', 'parent_notice', 'bulk_alimtalk']);
const SMS_KINDS = new Set(['direct', 'promo_sms', 'promo', 'report', 'parent_bms']);
const ALLOWED_KINDS = new Set([...KAKAO_KINDS, ...SMS_KINDS]);
// 종결 후 purge 대상 평문·외부 파일 참조 필드.
const PII_FIELDS = ['recipient_phone', 'fallback_text', 'template_variables', 'image_id'];

// 솔라피 호출은 T2(solapiProvider.js)에 위임. 정적 import를 피해 — 파일/시크릿 바인딩이
// 준비되기 전에도 워커·테스트가 로드되게 하고, 실제 발송 시점에만 동적 로드한다.
// getSolapiConfig()는 함수 실행 컨텍스트(시크릿 바인딩 상태)에서만 secret .value()가 유효하므로
// 발송 직전에 호출해 sendKakaoAlimtalk(payload, config)로 넘긴다. 테스트는 deps.sender로 대체.
async function defaultSender(payload) {
  const mod = await import('./solapiProvider.js');
  const config = mod.getSolapiConfig();
  if (SMS_KINDS.has(payload.kind)) return mod.sendSms(payload, config);
  return mod.sendKakaoAlimtalk(payload, config);
}

// 발송결과 사후 조회기(폴링). 접수≠도달이므로 groupId로 최종 발송결과를 조회한다.
async function defaultResultFetcher(groupId) {
  const mod = await import('./solapiProvider.js');
  const config = mod.getSolapiConfig();
  return mod.fetchSmsResult(groupId, config);
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

function smsTextFor(data) {
  const base = data.content ?? '';
  return data.sms_suffix ? `${base}\n\n${data.sms_suffix}` : base;
}

// 큐 doc → provider payload. kind별로 provider 입력이 다르다(알림톡=템플릿, 자유본문=문자).
function buildSendPayload(data, now = new Date()) {
  if (SMS_KINDS.has(data.kind)) {
    return {
      to: data.recipient_phone,
      text: smsTextFor(data),
      scheduledDate: scheduledDateForPayload(data, now),
      kind: data.kind,
      ...((data.kind === 'direct' || data.kind === 'promo_sms') && data.image_id
        ? { imageId: data.image_id }
        : {}),
    };
  }
  return {
    to: data.recipient_phone,
    templateCode: data.template_code,
    templateVariables: data.template_variables ?? {},
    fallbackText: data.fallback_text ?? '',
    scheduledDate: scheduledDateForPayload(data, now),
    kind: data.kind,
  };
}

function smsChannelFor(data) {
  return data.image_id ? 'mms' : 'sms';
}

function scheduledAtFor(data) {
  return data?.scheduled_date ? parseKstToDate(data.scheduled_date) : null;
}

function scheduledDateForPayload(data, now = new Date()) {
  const scheduledAt = scheduledAtFor(data);
  return scheduledAt && scheduledAt > now ? data.scheduled_date : undefined;
}

async function resolveQueuedMessageVars(db, ref, data) {
  if (!SMS_KINDS.has(data.kind) || !hasVarTokens(data.content ?? '')) return null;
  if (!data.student_id) return '학생 정보가 없어 메시지 변수를 치환할 수 없습니다.';

  const student = await db.collection('students').doc(data.student_id).get();
  if (!student.exists) return '학생을 찾을 수 없어 메시지 변수를 치환할 수 없습니다.';

  data.content = applyMessageVars(data.content, student.data());
  await ref.update({ content: data.content, updated_at: FieldValue.serverTimestamp() });
  return null;
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
  // kind 경계(T8 항목3): 승인된 알림톡과 문자 kind만 이 워커로 발송한다.
  // 알 수 없는 kind가 큐를 재사용해 검증 없이 나가는 것을 차단 — 발송 없이 영구 종결.
  if (!ALLOWED_KINDS.has(data.kind)) {
    await markPermanent(db, ref, data, (data.attempt_count ?? 0) + 1, {
      statusCode: 'kind_not_allowed',
      message: `허용되지 않은 kind: ${data.kind ?? '(none)'} — promo는 별도 동의 게이트 필요`,
      channel: null,
    });
    await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel: null });
    return;
  }

  const variableError = await resolveQueuedMessageVars(db, ref, data);
  if (variableError) {
    await markPermanent(db, ref, data, (data.attempt_count ?? 0) + 1, {
      statusCode: 'unresolved_message_vars',
      message: variableError,
      channel: null,
    });
    await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel: null });
    return;
  }

  // 발송 직전 마커 — 이 이후 크래시하면 솔라피 접수 여부가 불확실하다. sweeper가 리스 회수 시
  // 이 마커를 보고 자동 재발송 대신 수동 검토(failed_permanent)로 종결해 중복 발송을 차단한다.
  await ref.update({ sent_attempt_at: FieldValue.serverTimestamp() });

  // provider는 예외를 던지지 않지만, 방어적 catch 경로는 일시적 미상 오류로 재시도 취급한다.
  let result;
  try {
    result = await sender(buildSendPayload(data, now));
  } catch (err) {
    result = { ok: false, retryable: true, statusCode: null, channel: null, errorMessage: String(err?.message || err) };
  }

  if (result?.ok) {
    if (SMS_KINDS.has(data.kind) && result.groupId) {
      // SMS/LMS 접수 성공(2000)도 통신사 도달을 보장하지 않는다(예: 3058 "전송경로 없음"은
      // 비동기 발송결과에만 나타남). 종결하지 않고 발송결과 폴링이 도달/실패를 확정한다.
      // groupId가 없으면 사후조회가 불가능(매번 missing_group_id로 읽혀 중복 재발송 유발)하므로
      // 폴링에 넣지 않고 아래에서 기존처럼 즉시 종결한다.
      const scheduledAt = scheduledAtFor(data);
      const resultCheckBase = scheduledAt && scheduledAt > now ? scheduledAt : now;
      await markAwaitingDeliveryResult(db, ref, data, result, new Date(resultCheckBase.getTime() + DELIVERY_FIRST_DELAY_MS));
      return;
    }
    await markSent(db, ref, data, result);
    await fireResultCallback(notifyResultCallback, ref, data, { status: 'sent', channel: result.channel });
    return;
  }

  // 접수 단계 실패(잘못된 번호/템플릿/네트워크 등).
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

// SMS/LMS 접수 성공 → 발송결과 대기.
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

// SMS/LMS/MMS 도달 확정(4000): 종결 + 실제 문자 채널 로그.
async function finalizeSmsDelivered(db, ref, data, notifyResultCallback) {
  const channel = smsChannelFor(data);
  await ref.update({
    status: 'sent',
    delivery_check_at: null,
    purge_after: new Date(Date.now() + RETENTION_MS),
    updated_at: FieldValue.serverTimestamp(),
  });
  await writeMessageLog(db, data, ref.id, { status: 'sent', channel, statusCode: SMS_DELIVERED_CODE });
  await fireResultCallback(notifyResultCallback, ref, data, { status: 'sent', channel });
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
  const result = await resultFetcher(data.solapi_group_id);
  const count = (data.delivery_check_count ?? 0) + 1;
  const attemptCount = data.attempt_count ?? 0;

  switch (result?.outcome) {
    case 'delivered':
      await finalizeSmsDelivered(db, ref, data, notifyResultCallback);
      return;
    case 'failed':
      // SMS 통신사 미도달(예: 3058)은 일시적일 수 있어 상한까지 재발송, 이후 영구 실패로 종결.
      if (attemptCount < MAX_ATTEMPTS) {
        await markSmsRetry(db, ref, attemptCount, result.statusCode);
      } else {
        const channel = smsChannelFor(data);
        await markPermanent(db, ref, data, attemptCount, { statusCode: result.statusCode, message: result.statusMessage, channel });
        await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel });
      }
      return;
    default: // 'pending' 또는 미상 — 재조회. 상한 초과 시 중복 방지를 위해 미확정 실패로 종결.
      if (count >= MAX_DELIVERY_CHECKS) {
        // SMS 접수 성공분은 도달했을 공산이 크다(결과 미수신 ≠ 발송 실패). 재발송은 중복 위험이
        // 있으므로 재발송 없이 미확정으로 종결한다. (명시적 failed(예: 3058)만 재발송 대상.)
        const channel = smsChannelFor(data);
        await markPermanent(db, ref, data, attemptCount, { statusCode: 'delivery_result_timeout', message: '발송결과 미확정', channel });
        await fireResultCallback(notifyResultCallback, ref, data, { status: 'failed', channel });
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

// onSchedule(짧은 주기, 예 1분) 발송결과 폴링.
// SMS/LMS 결과를 확정한다.
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
