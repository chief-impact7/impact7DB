import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { handleLlmGenerate } from './src/llmHandler.js';
import { handleGenerateStudentReportAi } from './src/studentReportAiHandler.js';
import { handleSyncChatMessages } from './src/chatSyncHandler.js';
import {
  handleRunStudentReportAutomation,
  handleRunStudentReportBatchManual,
} from './src/studentReportAutomationHandler.js';
import { handleAttendanceCheckin } from './src/checkinHandler.js';
import { handleCreatePromoCampaign } from './src/promoCampaignHandler.js';
import { handleSetPromoConsent } from './src/promoConsentHandler.js';
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
// 종합상태 + 상담요약 + 다음상담 브리핑을 단일 호출로 생성(기존 consultation/status 콜러블 통합).
// Chat 언급은 syncChatMessages가 적재한 chat_messages를 조회하므로 여기엔 secret 불필요.
export const generateStudentReportAi = onCall({ enforceAppCheck: false }, handleGenerateStudentReportAi);

// CHAT_SA_KEY: DWD로 chief@를 가장해 Chat 메시지를 읽는 SA 키.
// 하루 1회 chief 스페이스 신규 메시지를 증분 수집 → 재원생 이름 태깅 → chat_messages 적재.
const CHAT_SA_KEY = defineSecret('CHAT_SA_KEY');
export const syncChatMessages = onSchedule(
  { schedule: 'every day 04:00', timeZone: 'Asia/Seoul', secrets: [CHAT_SA_KEY] },
  () => handleSyncChatMessages(),
);

// 학생 AI 종합 리포트 일괄/자동 생성 (로드맵 단계 8) — "타임박스 + 커서 재개" 청크 모델.
// scheduled: 5분마다 깨어나 진행 중 배치(batch_active)면 다음 청크를 이어받고, 아니면
//   automation_settings(interval/run_day/run_hour) 매칭 시 새 배치를 시작. 한 청크는 8분 예산 내로
//   끝나고 미처리분은 다음 틱이 이어받아 500+ 명도 540s timeout에 닿지 않는다. 할 일 없으면 즉시 return.
export const runStudentReportAutomation = onSchedule(
  { schedule: '*/5 * * * *', timeZone: 'Asia/Seoul', timeoutSeconds: 540, memory: '512MiB' },
  () => handleRunStudentReportAutomation(),
);
// manual: director 등급 이상이 새 배치를 즉시 시작(첫 청크). 미완료분은 scheduled 5분 틱이 이어받음.
// 진행률은 automation_settings(progress_done/progress_total/batch_active)를 onSnapshot 구독.
export const runStudentReportBatchManual = onCall(
  { enforceAppCheck: false, timeoutSeconds: 540, memory: '512MiB' },
  handleRunStudentReportBatchManual,
);

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

// 홍보(브랜드 메시지) 캠페인 발송 — 원장 권한. 동의/번호 게이트 후 message_queue(kind=promo) 배치 enqueue.
// 야간(광고 제한)이면 익일 08:00 자동 예약. 발송은 워커(onMessageQueued)가 수행.
export const createPromoCampaign = onCall({ enforceAppCheck: false }, handleCreatePromoCampaign);

// 홍보 광고 수신동의 설정/철회(옵트아웃). 직원 권한. 철회 시 이후 캠페인 SMS 대체에서 영구 제외.
export const setPromoConsent = onCall({ enforceAppCheck: false }, handleSetPromoConsent);

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
