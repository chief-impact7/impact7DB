import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { handleLlmGenerate } from './src/llmHandler.js';
import { handleGenerateStudentReportAi } from './src/studentReportAiHandler.js';
import { handleGenerateBoardBriefing } from './src/boardBriefingHandler.js';
import { handleSyncChatMessages } from './src/chatSyncHandler.js';
import {
  handleRunStudentReportAutomation,
  handleRunStudentReportBatchManual,
} from './src/studentReportAutomationHandler.js';
import { handleAttendanceCheckin } from './src/checkinHandler.js';
import { handleTabletCheckin } from './src/tabletCheckinHandler.js';
import { handleTabletAttendanceLog } from './src/attendanceLogHandler.js';
import { handleStaffCheckin } from './src/staffCheckinHandler.js';
import { handleEditStaffAttendance } from './src/staffAttendanceEditHandler.js';
import { handleDeleteStaffAttendance } from './src/staffAttendanceDeleteHandler.js';
import { handleCreatePromoCampaign } from './src/promoCampaignHandler.js';
import { handleSetPromoConsent } from './src/promoConsentHandler.js';
import { handleSendParentNotice } from './src/parentNoticeHandler.js';
import { handleSendDirectMessage } from './src/directMessageHandler.js';
import { handleCreateBulkMessage, handleGetBulkStaffRecipients } from './src/bulkMessageHandler.js';
import { handleGetSolapiAlimtalkTemplates } from './src/alimtalkTemplateHandler.js';
import { handleSendDailyReport } from './src/dailyReportHandler.js';
import { runPromoConsentReconfirm } from './src/promoConsentReconfirm.js';
import { handleRetryMessageDelivery, handleManageMessageFailure } from './src/messageRetryHandler.js';
import { handleGetMessageDeliveryStatus } from './src/messageDeliveryHandler.js';
import { handleGetRecipientMessageHistory } from './src/messageHistoryHandler.js';
import { processQueueDoc, runRetrySweep, runDeliveryResultSweep, purgeExpiredPii } from './src/queueWorker.js';
import { runTemplateAuditSweep } from './src/templateAuditSweep.js';
import { runAbsenceNoticeSweep, handleSendAbsenceNotice, syncAbsenceNoticeDeliveryStatus } from './src/absenceNoticeSweep.js';
import { handleGetHrPublicToken } from './src/hrPublicTokenHandler.js';
import { handleSubmitEmployeeContractSignature } from './src/employeeContractSignatureHandler.js';
import { handleSubmitContractSignature, handleSubmitSalaryAgreementSignature } from './src/contractSignatureHandler.js';
import {
  handleHrUploadStaffDocument,
  handleHrUploadContract,
  handleHrUploadSignedContract,
  handleHrGetFileUrl,
  handleHrUploadEntityDocument,
  handleHrDeleteFile,
} from './src/hrUploadHandler.js';
import { SOLAPI_API_KEY, SOLAPI_API_SECRET } from './src/solapiSecrets.js';
import { runOptOut080Sync } from './src/optOut080Sync.js';
import { handleGetManualOptOuts, handleRegisterManualOptOut } from './src/manualOptOutHandler.js';
import { handleGetAttendanceNotificationGaps, runAttendanceNotificationGapSnapshot } from './src/attendanceNotificationGap.js';
import { computeLabelUpdate } from './src/studentLabelSync.js';
import { handleStaffAutoClockout } from './src/staffAutoClockoutHandler.js';
import { handleStaffAutoClockin } from './src/staffAutoClockinHandler.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// App Check 도입 보류(사용자 결정 2026-07-05) — 전 앱 클라 init 제거됨, enforce 전환 금지.
// 재개 시 .memory/project_appcheck_rollout.md 참조. 호출자 보호는 request.auth(직원) + rate limit 유지.
export const llmGenerate = onCall({ enforceAppCheck: false }, handleLlmGenerate);
// 종합상태 + 상담요약 + 다음상담 브리핑을 단일 호출로 생성(기존 consultation/status 콜러블 통합).
// Chat 언급은 syncChatMessages가 적재한 chat_messages를 조회하므로 여기엔 secret 불필요.
export const generateStudentReportAi = onCall({ enforceAppCheck: false }, handleGenerateStudentReportAi);

// impact7board 칸반 보드 주간 AI 브리핑 — board_cards 스냅샷(컬럼별 수·정체·마감임박)을 Gemini로 요약해
// board_briefings/{board}_{isoWeek}에 저장. 같은 주 문서가 있으면 force!==true일 때 캐시를 그대로 반환(재호출 없음).
export const generateBoardBriefing = onCall({ enforceAppCheck: false }, handleGenerateBoardBriefing);

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

// HR 공개 페이지(비로그인 신규입사·계약 서명) 토큰 게이트 read 대체 (보안 G02).
// PUBLIC·토큰 게이트 — request.auth 없이 호출되며(외부인이 impact7 계정 없이 접근), 핸들러가
// 토큰 존재/사용여부/만료를 검증한 뒤 각 페이지가 표시하는 최소 필드만 마스킹해 반환한다.
// 주민번호·계좌번호 평문, taxInfo, 문서스캔은 반환하지 않는다. assertAuthorizedStaff 미사용(의도).
export const getHrPublicToken = onCall({ enforceAppCheck: false }, handleGetHrPublicToken);

// Task rules45 #4: 공개(비로그인) 근로계약서 서명 제출 — PUBLIC·토큰 게이트.
// 비인증 서명자가 막히던 staff.status='active' write를 서버로 이전. 토큰 검증 후
// 계약 서명+status, staff.status='active', 토큰 소진을 단일 트랜잭션으로 원자 갱신한다.
// 경로 ID는 토큰 doc에서만 도출(호출자 입력 무시). assertAuthorizedStaff 미사용(의도).
export const submitEmployeeContractSignature = onCall({ enforceAppCheck: false }, handleSubmitEmployeeContractSignature);

// 공개(비로그인) 강사계약·급여약정 서명 제출 — PUBLIC·토큰 게이트. submitEmployeeContractSignature와
// 동일 패턴으로, 비인증 client가 staff/{id}/contracts/{id}에 직접 write하던 서명을 서버로 이전.
// rules는 최상위 키만 검증해 signatures.director 덮어쓰기·SVG XSS를 못 막으므로, 서버가 raster
// 서명만 검증·write하고 토큰을 소진한다. 경로 ID는 토큰 doc에서만 도출(호출자 입력 무시).
export const submitContractSignature = onCall({ enforceAppCheck: false }, handleSubmitContractSignature);
export const submitSalaryAgreementSignature = onCall({ enforceAppCheck: false }, handleSubmitSalaryAgreementSignature);

// H-01: HR 파일 접근을 전부 callable 경유로 옮기는 서버 골격(ADDITIVE — storage.rules는 후속 단계).
// 업로드는 base64를 받아 서버가 크기(<20MB)·MIME(PDF/이미지, 매직넘버 재검증)을 검증한 뒤
// Admin SDK로 write한다(서명 write URL 불필요 → signBlob 의존 없음). 다운로드는 Firebase
// download token 기반 URL(client getDownloadURL과 동일 형태)을 발급한다.
// 인증 업로드(직원문서·관리자 계약 PDF)는 원장급 게이트(assertDirector).
export const hrUploadStaffDocument = onCall({ enforceAppCheck: false }, handleHrUploadStaffDocument);
export const hrUploadContract = onCall({ enforceAppCheck: false }, handleHrUploadContract);
// 공개(비로그인) 서명자 PDF 업로드 — 토큰 게이트(존재·미사용·미만료). HR-13 degrade 수정.
// ownerId/contractId는 토큰 doc에서 도출(호출자 입력 무시). assertAuthorizedStaff 미사용(의도).
export const hrUploadSignedContract = onCall({ enforceAppCheck: false }, handleHrUploadSignedContract);
// 다운로드 URL 발급 — 인증(원장급, HR 경로) 또는 공개 토큰(자기 계약 경로만).
export const hrGetFileUrl = onCall({ enforceAppCheck: false }, handleHrGetFileUrl);
// 사업자(법인) 문서 업로드(entities/) + HR 파일 삭제 — 원장급 게이트.
export const hrUploadEntityDocument = onCall({ enforceAppCheck: false }, handleHrUploadEntityDocument);
export const hrDeleteFile = onCall({ enforceAppCheck: false }, handleHrDeleteFile);

export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);

// === 카카오/결제/출결 (골격 — 본문은 2026 하반기) ===

// 카카오 알림톡 발송 (Callable). 실 API 연동은 나중.
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
// minInstances:1 — 키오스크 첫 스캔 콜드스타트(~1.4s) 제거. 상시 1인스턴스 웜 유지.
export const tabletCheckin = onCall({ enforceAppCheck: false, minInstances: 1 }, handleTabletCheckin);

// 태블릿 출결 조회 — 당일 attendance_events·daily_records·학생 명단을 한 번에 반환(정렬은 클라).
export const tabletAttendanceLog = onCall({ enforceAppCheck: false }, handleTabletAttendanceLog);

// 직원 출퇴근 — 휴대폰 번호(phoneKey)로 조회(후보+허용액션)와 확정(staff_attendance 적재). 알림 없음.
// minInstances:1 — 키오스크와 동시 호출되므로 함께 웜 유지(콜드스타트 ~1.6s 제거).
export const staffCheckin = onCall({ enforceAppCheck: false, minInstances: 1 }, handleStaffCheckin);

// 근태 레코드 보정 — manager+가 staff_attendance의 출근/퇴근 시각·메모를 교정(write:false라 callable admin만 수정).
// 별도 저장소 impact7HR UI가 호출. region(asia-northeast3) 전역 상속.
export const editStaffAttendance = onCall({ enforceAppCheck: false }, handleEditStaffAttendance);

// 직원 삭제 cascade — 원장이 직원을 삭제할 때 staff_attendance(write:false) 레코드를 정리.
// 별도 저장소 impact7HR UI가 호출. region(asia-northeast3) 전역 상속.
export const deleteStaffAttendance = onCall({ enforceAppCheck: false }, handleDeleteStaffAttendance);

// 홍보 문자 캠페인 발송 — 원장 권한. 동의/번호 게이트 후 message_queue(kind=promo_sms) 배치 enqueue.
// 야간(광고 제한)이면 익일 08:00 자동 예약. 발송은 워커(onMessageQueued)가 수행.
export const createPromoCampaign = onCall(
  { enforceAppCheck: false, timeoutSeconds: 540, memory: '512MiB', secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleCreatePromoCampaign,
);

// 홍보 광고 수신동의 설정/철회(옵트아웃). 직원 권한. 철회 시 이후 광고 문자에서 영구 제외.
export const setPromoConsent = onCall({ enforceAppCheck: false }, handleSetPromoConsent);

// 개별 학부모 정보성 안내(알림톡) 발송 — 학생 상세 '메시지' 탭. 직원 권한. 동의·야간 제한 없음.
export const sendParentNotice = onCall(
  { enforceAppCheck: false, secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleSendParentNotice,
);

// 수동 미등원 안내 발송 — 로그북 '미도착(연락)'에서 직원이 확인 후 클릭. 자동 스윕과 멱등 컬렉션 공유.
export const sendAbsenceNotice = onCall({ enforceAppCheck: false }, handleSendAbsenceNotice);

// 임의 번호 정보성 SMS/LMS/MMS 발송 — 메시지 센터 휴대폰 문자 발송. 직원 권한.
export const sendDirectMessage = onCall(
  { enforceAppCheck: false, secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleSendDirectMessage,
);

// 직원이 요청받은 번호를 솔라피 발송 차단 목록에 직접 등록. 관리자 권한 + Secret 바인딩.
export const registerManualOptOut = onCall(
  { enforceAppCheck: false, secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleRegisterManualOptOut,
);
export const getManualOptOuts = onCall(
  { enforceAppCheck: false, secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleGetManualOptOuts,
);

// 정보성 대용량 발송 — 메시지 센터 ②블록. 직원 권한. message_queue(kind=direct) 배치 enqueue.
export const createBulkMessage = onCall(
  { enforceAppCheck: false, timeoutSeconds: 540, memory: '512MiB', secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleCreateBulkMessage,
);
export const getBulkStaffRecipients = onCall({ enforceAppCheck: false }, handleGetBulkStaffRecipients);
export const getSolapiAlimtalkTemplates = onCall(
  { enforceAppCheck: false, secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleGetSolapiAlimtalkTemplates,
);

// 일일 학습 리포트 문자 발송 — 직원 권한.
export const sendDailyReport = onCall({ enforceAppCheck: false }, handleSendDailyReport);

// 광고 수신동의 2년 주기 재확인(정보통신망법 §50의8) — 매일 KST 09:00. 골격: 대상 식별·집계.
// 실제 통지 발송은 동의자·수단 확정 후 연결.
export const promoConsentReconfirm = onSchedule(
  { schedule: 'every day 09:00', timeZone: 'Asia/Seoul' },
  () => runPromoConsentReconfirm(),
);

// 솔라피 080 수신거부 명단 → 학생 동의 기록(철회) 동기화 — 6시간 주기.
export const optOut080Sweeper = onSchedule(
  { schedule: 'every 6 hours', timeZone: 'Asia/Seoul', secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  () => runOptOut080Sync(),
);

// 관리자 발송 현황 화면(T6)의 수동 재시도 — 실패 큐 doc을 failed_retryable로 되돌려 sweeper 재처리.
export const retryMessageDelivery = onCall({ enforceAppCheck: false }, handleRetryMessageDelivery);

// 실패 항목 보관(직원)/삭제(원장) — 발송 현황 실패 목록 정리.
export const manageMessageFailure = onCall({ enforceAppCheck: false }, handleManageMessageFailure);

// 수신자별 발송 이력 타임라인 — 카카오 관리자센터에서 안 보이는 알림톡 원문 복원용.
export const getRecipientMessageHistory = onCall({ enforceAppCheck: false }, handleGetRecipientMessageHistory);

// 발송 현황 집계 — 큐 read를 차단(T11)하므로 대시보드는 이 callable로 카운트+마스킹 실패목록만 받는다.
// 솔라피 잔액 표시용 secret 바인딩 — SDK 자체는 잔액 조회 시에만 동적 로드(콜드스타트 무영향).
export const getMessageDeliveryStatus = onCall(
  { enforceAppCheck: false, secrets: [SOLAPI_API_KEY, SOLAPI_API_SECRET] },
  handleGetMessageDeliveryStatus,
);

// 전날 정규·자유학기 출석·지각·조퇴 중 학부모 수업 리포트가 발송 완료되지 않은 명단. 매일 KST 15:00 확정 스냅샷.
export const attendanceNotificationGapSweeper = onSchedule(
  { schedule: '0 15 * * *', timeZone: 'Asia/Seoul' },
  () => runAttendanceNotificationGapSnapshot(),
);
export const getAttendanceNotificationGaps = onCall(
  { enforceAppCheck: false },
  handleGetAttendanceNotificationGaps,
);

// === 메시지 큐 워커 (T3) ===
// 큐 등록 즉시 단발 발송. 솔라피 호출은 src/queueWorker.js → solapiProvider(T2)에 위임.
// 솔라피 secret(.value())은 함수 런타임에서만 접근 가능하므로 두 함수에 바인딩한다.
const SOLAPI_SECRETS = [SOLAPI_API_KEY, SOLAPI_API_SECRET];

export const onMessageQueued = onDocumentCreated(
  { document: 'message_queue/{id}', secrets: SOLAPI_SECRETS, maxInstances: 1, concurrency: 5 },
  (event) => processQueueDoc(event),
);

// message_queue 전체 쓰기에 걸리는 4번째 리스너(아래 onAbsenceNoticeQueueUpdated) 참고 — status·
// last_error_code 필드명을 여기서 바꾸면 그쪽 미러링도 함께 깨진다.

// 전송 실패(failed_retryable) 재시도 sweeper — 5분 주기, KST 기준.
// 같은 주기에 종결 doc의 평문 PII purge(보존기간 경과분)도 수행(T8 항목1).
export const retrySweeper = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Asia/Seoul', secrets: SOLAPI_SECRETS },
  async () => {
    await runRetrySweep();
    await purgeExpiredPii();
  },
);

// SMS/LMS 발송결과 폴링(1분 주기) — 접수(2000) 후 getGroupMessages로 최종 도달 여부를 확정.
export const deliveryResultSweeper = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Asia/Seoul', secrets: SOLAPI_SECRETS },
  () => runDeliveryResultSweep(),
);

// 알림톡 템플릿 정합성 스윕(매일 KST 09:30) — 솔라피 템플릿 목록과 env 템플릿 코드를 대조해
// 미주입·비승인·수정·미매핑을 template_audit/latest에 기록(발송 현황 카드가 경고 표시).
export const templateAuditSweeper = onSchedule(
  { schedule: '30 9 * * *', timeZone: 'Asia/Seoul', secrets: SOLAPI_SECRETS },
  () => runTemplateAuditSweep(),
);

// 미등원(결석) 자동 안내 — 15분 주기. 등원예정+유예(40분) 경과했는데 미체크인(day_state=미등원)인
// tablet-eligible 학생 학부모에게 1회 발송(큐 등록만, 발송은 워커). ABSENCE_SWEEP_ENABLED='true'일
// 때만 실제 동작 — 기본 비활성이라 예정시각 정확도(오탐 0)를 검증한 뒤 env로 켠다.
export const absenceNoticeSweeper = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'Asia/Seoul', timeoutSeconds: 540, memory: '512MiB' },
  () => runAbsenceNoticeSweep(),
);

// 미등원 알림톡 큐 doc의 상태 변화(처리중/재시도/성공/실패 전부)를 absence_notices에 반영 —
// 로그북 '미도착' 배지가 발송 요청 여부뿐 아니라 처리 경과·최종 결과까지 보여주도록.
export const onAbsenceNoticeQueueUpdated = onDocumentWritten(
  { document: 'message_queue/{id}' },
  (event) => syncAbsenceNoticeDeliveryStatus(event),
);

// 직원 미퇴근 자동 처리 — 매일 KST dayStartHour(기본 06:00)에 전날 근무중 직원을 설정 시각으로 자동 퇴근.
// settings/staff_attendance.autoClockOut.{byStaff,byDept,global} 우선순위. null이면 스킵.
export const staffAutoClockout = onSchedule(
  { schedule: '0 6 * * *', timeZone: 'Asia/Seoul' },
  () => handleStaffAutoClockout(),
);

// 직원 미출근 자동 출근 — 매일 KST dayStartHour(기본 06:00)에 전날 미출근 직원 중 autoClockIn 설정된 직원만 처리.
export const staffAutoClockin = onSchedule(
  { schedule: '0 6 * * *', timeZone: 'Asia/Seoul' },
  () => handleStaffAutoClockin(),
);

// 어떤 경로로 쓰이든 school/level/grade → school_level_grade 자동 동기화(stale 차단).
export const onStudentLabelSync = onDocumentWritten(
  { document: 'students/{docId}' },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return null; // 삭제는 무시
    const update = computeLabelUpdate(after.data());
    if (!update) return null; // 라벨 동일 → write 스킵(무한루프 방지)
    // updated_at 갱신 — 클라 증분 동기화가 라벨 후속 write를 놓치지 않게 한다.
    // 재발화는 computeLabelUpdate null 가드가 종료시키므로 루프 없음.
    const { FieldValue } = await import('firebase-admin/firestore');
    await after.ref.update({ ...update, updated_at: FieldValue.serverTimestamp() });
    return null;
  }
);
