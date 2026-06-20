import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { maskPhone } from './phoneMask.js';

// 메시지 큐 워커 — 계약 정본(message-architect_api-contract §2.4, §4.1) 기준.
// status 전이: pending → processing → sent | failed_retryable | failed_permanent.
// fallback(SMS/LMS)은 솔라피 내장 대체발송이므로 워커는 SMS를 따로 보내지 않고
// 솔라피 최종 채널(message_logs.channel)만 기록한다.

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
      disableSms: true, // 비친구는 이미 가입안내로 분기됨 — SMS 대체 안 함
      targeting: data.targeting ?? 'I',
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
async function dispatch(db, ref, data, sender, notifyResultCallback) {
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

  // provider는 예외를 던지지 않지만, 방어적 catch 경로는 일시적 미상 오류로 재시도 취급한다.
  let result;
  try {
    result = await sender(buildSendPayload(data));
  } catch (err) {
    result = { ok: false, retryable: true, statusCode: null, channel: null, errorMessage: String(err?.message || err) };
  }

  if (result?.ok) {
    await markSent(db, ref, data, result);
    await fireResultCallback(notifyResultCallback, ref, data, { status: 'sent', channel: result.channel });
    return;
  }

  // 재시도 판정 정본은 provider의 result.retryable(불리언). statusCode 파싱하지 않는다
  // (NetworkError·429 rate limit이 '5'로 시작하지 않아 오판되기 때문 — T2↔T3 공동 확정).
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

// onDocumentCreated('message_queue/{id}') 단발 처리.
export async function processQueueDoc(event, deps = {}) {
  const db = deps.db ?? getFirestore();
  const sender = deps.sender ?? defaultSender;
  const notifyResultCallback = deps.notifyResultCallback ?? defaultNotifyResultCallback;
  const ref = event?.data?.ref ?? db.collection('message_queue').doc(event.params.id);
  const claimed = await claimForProcessing(db, ref, 'pending');
  if (!claimed) return null; // 이미 처리됐거나 중복 트리거
  await dispatch(db, ref, claimed, sender, notifyResultCallback);
  return null;
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
    await dispatch(db, doc.ref, claimed, sender, notifyResultCallback);
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
