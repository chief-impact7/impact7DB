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
import { handleTabletCheckin } from './src/tabletCheckinHandler.js';
import { handleCreatePromoCampaign } from './src/promoCampaignHandler.js';
import { handleSetPromoConsent } from './src/promoConsentHandler.js';
import { handleSendParentNotice } from './src/parentNoticeHandler.js';
import { handleGetStudentMessages } from './src/studentMessagesHandler.js';
import { handleSendDirectMessage } from './src/directMessageHandler.js';
import { handleCreateBulkMessage } from './src/bulkMessageHandler.js';
import { handleSyncChannelFriends, handleGetChannelFriends } from './src/channelFriendsHandler.js';
import { handleSendDailyReport } from './src/dailyReportHandler.js';
import { runPromoConsentReconfirm } from './src/promoConsentReconfirm.js';
import { handleRetryMessageDelivery } from './src/messageRetryHandler.js';
import { handleGetMessageDeliveryStatus } from './src/messageDeliveryHandler.js';
import { processQueueDoc, runRetrySweep, purgeExpiredPii } from './src/queueWorker.js';
import { handleGetHrPublicToken } from './src/hrPublicTokenHandler.js';
import {
  handleHrUploadStaffDocument,
  handleHrUploadContract,
  handleHrUploadSignedContract,
  handleHrGetFileUrl,
  handleHrUploadEntityDocument,
  handleHrDeleteFile,
} from './src/hrUploadHandler.js';
import { SOLAPI_API_KEY, SOLAPI_API_SECRET } from './src/solapiSecrets.js';
import { computeLabelUpdate } from './src/studentLabelSync.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// App Check enforce (N-05 카나리). DSC가 App Check init(reCAPTCHA Enterprise) 배포됨 → 토큰 검증.
// 문제 시 false로 즉시 롤백. 호출자 보호는 request.auth(직원) + rate limit도 유지.
export const llmGenerate = onCall({ enforceAppCheck: true }, handleLlmGenerate);
// 종합상태 + 상담요약 + 다음상담 브리핑을 단일 호출로 생성(기존 consultation/status 콜러블 통합).
// Chat 언급은 syncChatMessages가 적재한 chat_messages를 조회하므로 여기엔 secret 불필요.
export const generateStudentReportAi = onCall({ enforceAppCheck: true }, handleGenerateStudentReportAi);

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
  { enforceAppCheck: true, timeoutSeconds: 540, memory: '512MiB' },
  handleRunStudentReportBatchManual,
);

// HR 공개 페이지(비로그인 신규입사·계약 서명) 토큰 게이트 read 대체 (보안 G02).
// PUBLIC·토큰 게이트 — request.auth 없이 호출되며(외부인이 impact7 계정 없이 접근), 핸들러가
// 토큰 존재/사용여부/만료를 검증한 뒤 각 페이지가 표시하는 최소 필드만 마스킹해 반환한다.
// 주민번호·계좌번호 평문, taxInfo, 문서스캔은 반환하지 않는다. assertAuthorizedStaff 미사용(의도).
export const getHrPublicToken = onCall({ enforceAppCheck: false }, handleGetHrPublicToken);

// H-01: HR 파일 접근을 전부 callable 경유로 옮기는 서버 골격(ADDITIVE — storage.rules는 후속 단계).
// 업로드는 base64를 받아 서버가 크기(<20MB)·MIME(PDF/이미지, 매직넘버 재검증)을 검증한 뒤
// Admin SDK로 write한다(서명 write URL 불필요 → signBlob 의존 없음). 다운로드는 Firebase
// download token 기반 URL(client getDownloadURL과 동일 형태)을 발급한다.
// 인증 업로드(직원문서·관리자 계약 PDF)는 원장급 게이트(assertDirector).
export const hrUploadStaffDocument = onCall({ enforceAppCheck: true }, handleHrUploadStaffDocument);
export const hrUploadContract = onCall({ enforceAppCheck: true }, handleHrUploadContract);
// 공개(비로그인) 서명자 PDF 업로드 — 토큰 게이트(존재·미사용·미만료). HR-13 degrade 수정.
// ownerId/contractId는 토큰 doc에서 도출(호출자 입력 무시). assertAuthorizedStaff 미사용(의도).
export const hrUploadSignedContract = onCall({ enforceAppCheck: false }, handleHrUploadSignedContract);
// 다운로드 URL 발급 — 인증(원장급, HR 경로) 또는 공개 토큰(자기 계약 경로만).
export const hrGetFileUrl = onCall({ enforceAppCheck: false }, handleHrGetFileUrl);
// 사업자(법인) 문서 업로드(entities/) + HR 파일 삭제 — 원장급 게이트.
export const hrUploadEntityDocument = onCall({ enforceAppCheck: true }, handleHrUploadEntityDocument);
export const hrDeleteFile = onCall({ enforceAppCheck: true }, handleHrDeleteFile);

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

// 태블릿 키오스크 출결·외출 — 조회(후보+허용액션)와 확정(이벤트·daily 동기화·알림톡·하원게이트) 단일 callable.
export const tabletCheckin = onCall({ enforceAppCheck: false }, handleTabletCheckin);

// 홍보(브랜드 메시지) 캠페인 발송 — 원장 권한. 동의/번호 게이트 후 message_queue(kind=promo) 배치 enqueue.
// 야간(광고 제한)이면 익일 08:00 자동 예약. 발송은 워커(onMessageQueued)가 수행.
export const createPromoCampaign = onCall({ enforceAppCheck: true }, handleCreatePromoCampaign);

// 홍보 광고 수신동의 설정/철회(옵트아웃). 직원 권한. 철회 시 이후 캠페인 SMS 대체에서 영구 제외.
export const setPromoConsent = onCall({ enforceAppCheck: true }, handleSetPromoConsent);

// 개별 학부모 정보성 안내(알림톡) 발송 — 학생 상세 '메시지' 탭. 직원 권한. 동의·야간 제한 없음.
export const sendParentNotice = onCall({ enforceAppCheck: true }, handleSendParentNotice);

// 학생별 발송 내역(message_logs) 조회 — 메시지 탭 하단. 직원 권한.
export const getStudentMessages = onCall({ enforceAppCheck: true }, handleGetStudentMessages);

// 임의 번호 정보성 SMS 즉석 발송 — 메시지 센터 ③블록. 직원 권한. 번호별 kind=direct enqueue.
export const sendDirectMessage = onCall({ enforceAppCheck: true }, handleSendDirectMessage);

// 정보성 대용량 발송 — 메시지 센터 ②블록. 직원 권한. message_queue(kind=promo, targeting=I) 배치 enqueue.
export const createBulkMessage = onCall({ enforceAppCheck: true }, handleCreateBulkMessage);

// 카카오 채널 친구목록 업로드 동기화 / 조회 — 직원 권한.
export const syncChannelFriends = onCall({ enforceAppCheck: true }, handleSyncChannelFriends);
export const getChannelFriends = onCall({ enforceAppCheck: true }, handleGetChannelFriends);

// 일일 학습 리포트 발송 — 직원 권한. 친구→정보형 BMS, 비친구→가입안내 SMS.
export const sendDailyReport = onCall({ enforceAppCheck: true }, handleSendDailyReport);

// 광고 수신동의 2년 주기 재확인(정보통신망법 §50의8) — 매일 KST 09:00. 골격: 대상 식별·집계.
// 실제 통지 발송은 동의자·수단 확정 후 연결.
export const promoConsentReconfirm = onSchedule(
  { schedule: 'every day 09:00', timeZone: 'Asia/Seoul' },
  () => runPromoConsentReconfirm(),
);

// 관리자 발송 현황 화면(T6)의 수동 재시도 — 실패 큐 doc을 failed_retryable로 되돌려 sweeper 재처리.
export const retryMessageDelivery = onCall({ enforceAppCheck: true }, handleRetryMessageDelivery);

// 발송 현황 집계 — 큐 read를 차단(T11)하므로 대시보드는 이 callable로 카운트+마스킹 실패목록만 받는다.
export const getMessageDeliveryStatus = onCall({ enforceAppCheck: true }, handleGetMessageDeliveryStatus);

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
