import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { handleLlmGenerate } from './src/llmHandler.js';
import { handleGenerateStudentConsultationAi } from './src/consultationAiHandler.js';
import { handleAttendanceCheckin } from './src/checkinHandler.js';
import { handleRetryMessageDelivery } from './src/messageRetryHandler.js';
import { handleGetMessageDeliveryStatus } from './src/messageDeliveryHandler.js';
import { processQueueDoc, runRetrySweep, purgeExpiredPii } from './src/queueWorker.js';
import { SOLAPI_API_KEY, SOLAPI_API_SECRET } from './src/solapiSecrets.js';
import { computeLabelUpdate } from './src/studentLabelSync.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// App Check은 후속 과제: 현재 유일 호출자인 DSC가 App Check 미설정이라 false로 시작.
// 호출자 보호는 handleLlmGenerate의 request.auth(로그인 직원만)로 유지.
export const llmGenerate = onCall({ enforceAppCheck: false }, handleLlmGenerate);
export const generateStudentConsultationAi = onCall({ enforceAppCheck: false }, handleGenerateStudentConsultationAi);

export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);

// === 카카오/결제/출결 (골격 — 본문은 2026 하반기) ===

// 카카오 알림톡/친구톡 발송 (Callable). 실 API 연동은 나중.
export const sendKakao = onCall({ enforceAppCheck: false }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  throw new HttpsError('unimplemented', 'sendKakao: not implemented (카카오 API 확정 후)');
});

// PG 결제 웹훅 (HTTP). 서명검증·멱등은 src 유틸로 위임 예정.
export const paymentHook = onRequest({ invoker: 'public' }, (req, res) => {
  console.warn('[paymentHook] not implemented — received webhook, ignoring');
  res.status(503).json({ error: 'not implemented' });
});

// 태블릿 출결 체크인 (Callable). 조회(후보 disambiguation) + 확정(트랜잭션 원자 처리).
// request.auth(키오스크용 직원 Google 세션) 필수. 솔라피 호출은 워커가 비동기 처리.
export const attendanceCheckin = onCall({ enforceAppCheck: false }, handleAttendanceCheckin);

// 관리자 발송 현황 화면(T6)의 수동 재시도 — 실패 큐 doc을 failed_retryable로 되돌려 sweeper 재처리.
export const retryMessageDelivery = onCall({ enforceAppCheck: false }, handleRetryMessageDelivery);

// 발송 현황 집계 — 큐 read를 차단(T11)하므로 대시보드는 이 callable로 카운트+마스킹 실패목록만 받는다.
export const getMessageDeliveryStatus = onCall({ enforceAppCheck: false }, handleGetMessageDeliveryStatus);

// === 메시지 큐 워커 (T3) ===
// 큐 등록 즉시 단발 발송. 솔라피 호출은 src/queueWorker.js → solapiProvider(T2)에 위임.
// 솔라피 secret(.value())은 함수 런타임에서만 접근 가능하므로 두 함수에 바인딩한다.
const SOLAPI_SECRETS = [SOLAPI_API_KEY, SOLAPI_API_SECRET];

export const onMessageQueued = onDocumentCreated(
  { document: 'message_queue/{id}', secrets: SOLAPI_SECRETS },
  (event) => processQueueDoc(event),
);

// 전송 실패(failed_retryable) 재시도 sweeper — 5분 주기, KST 기준.
// 같은 주기에 종결 doc의 평문 PII purge(보존기간 경과분)도 수행(T8 항목1).
export const retrySweeper = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Asia/Seoul', secrets: SOLAPI_SECRETS },
  async () => {
    await runRetrySweep();
    await purgeExpiredPii();
  },
);

// 어떤 경로로 쓰이든 school/level/grade → school_level_grade 자동 동기화(stale 차단).
export const onStudentLabelSync = onDocumentWritten(
  { document: 'students/{docId}' },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return null; // 삭제는 무시
    const update = computeLabelUpdate(after.data());
    if (!update) return null; // 라벨 동일 → write 스킵(무한루프 방지)
    await after.ref.update(update);
    return null;
  }
);
