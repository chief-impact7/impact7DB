---
name: shared-backend-foundation
description: 카카오/문자/결제/출결알림 공유 백엔드는 impact7DB Cloud Functions로. AI 인증 통일(exam=Vertex 직접, DSC=게이트웨이)은 2026-05-22 실구현+배포 완료. 카카오/결제/출결은 골격만(미배포)
metadata:
  type: project
---

DSC/DB/HR/exam이 공유할 **횡단 백엔드 서비스**(카카오톡 알림톡/친구톡, 문자, 결제(PG), 출결연동 카톡 알림)를 impact7DB에 **Cloud Functions(codebase `shared`, `functions-shared/`)** 로 구성. 기존 `leave-request` codebase와 분리.

**Why:** 비밀키·공개 웹훅·이벤트 자동발송이 필요해 클라이언트 SPA만으론 불가능. 동일 키·템플릿이라 앱마다 중복하면 관리가 흩어짐. impact7DB가 rules·storage·Functions의 SSoT라 자연스러운 호스트.

## AI 인증 통일 — 실구현 + 배포 완료 (2026-05-22)

AI 호출을 **서버 + Vertex AI + ADC**로 통일. **하이브리드 경로**(코드 공유가 아니라 인증·백엔드 통일):
- **게이트웨이**: `functions-shared/llmGenerate` (onCall, asia-northeast3) **배포됨**. `@google/genai` vertex 모드, ADC. `request.auth` 필수, enforceAppCheck=false(DSC App Check 미설정), 호출당 `notification_logs` 기록. 에러는 resource-exhausted/unavailable/internal로 분류해 호출자 재시도 지원.
- **exam**: 자체 Next.js 서버에서 `@google-cloud/vertexai` 직접 호출(게이트웨이 미경유). 4모듈 전환 — `gemini.ts`/`vision.ts`/`growth-report/commentary.ts`/`analyses/generate.ts`. API 키 제거(ADC). App Hosting(exam-app-kr, asia-east1) 런타임 SA에 aiplatform.user 부여, 빌드·배포 SUCCESS.
- **DSC**: 클라 `firebase/ai`(VertexAIBackend) 제거 → `llmGenerate` Callable 경유 어댑터. gemini-queue/parent-message/consultation-ai 호환. hosting 배포됨(impact7dsc.web.app).
- **모델 (2026-05-22 통일):** 텍스트·모든 폴백·게이트웨이 기본 = **gemini-3.5-flash**(GA). 비전/커멘터리/분석 PRIMARY = **gemini-3.1-pro-preview**(preview — 3.x pro GA 미출시, `gemini-3.1-pro`는 Vertex 404). DSC = gemini-3.5-flash. 게이트웨이 ALLOWED_MODELS=[3.5-flash, 3.1-pro-preview]. 3.1-pro-preview의 thinkingConfig+responseMimeType json 동작 확인. 전부 Vertex global 200.

**조직 정책 완화 (중요):** gw.impact7.kr 조직의 `iam.allowedPolicyMemberDomains`가 allUsers를 막아 Callable/HTTP 함수의 public invoker 설정이 불가했음. **impact7db 프로젝트에만** 이 정책을 `allValues: ALLOW`로 override → public Cloud Functions/Run 가능. **향후 카카오 sendKakao(Callable)·결제 paymentHook(웹훅)도 이 완화 전제로 동작.** (함수는 request.auth/서명검증으로 보호; public invoker는 엔드포인트 도달만 허용.)

## 카카오/결제/출결 — 골격만 (미배포, 실 로직은 2026 하반기)

`functions-shared/`에 골격 존재하나 **배포 안 함**:
- `sendKakao`(onCall, unimplemented), `paymentHook`(onRequest 503), `onAttendance`(onDocumentWritten `attendance/{docId}`, 로그만)
- 공통 유틸 골격: `src/idempotency.js`(claimIdempotencyKey→payment_records 트랜잭션), `src/verifySignature.js`(throw not implemented)
- Firestore: `notification_logs`, `payment_records` 컬렉션 + rules 슬롯(`if false`, Admin SDK만). 4-repo 동기화 완료.
- Secret 슬롯: `kakao-api-key`, `pg-secret-key` placeholder 생성됨(실값은 계약 후).
- 실 로직(발송/PG 연동/서명검증)·실 키는 하반기. paymentHook은 실 로직 전 public+무검증이므로 배포 전 서명검증 필수.

## 안전 규율 — codebase 클로버링
- `firebase deploy --only functions:shared`로만 배포(leave-request·HR default 미관여). `--only functions:shared:llmGenerate`처럼 함수 단위도 가능.
- 새 공유 함수는 `functions-shared/`에만. `functions/`(leave-request)에 카카오·결제 코드 금지.
- IAM: compute SA(485669859162-compute) + App Hosting SA(firebase-app-hosting-compute)에 roles/aiplatform.user 부여됨.

**설계/계획 문서:** `docs/superpowers/specs/2026-05-22-shared-backend-ai-unification-design.md`, `docs/superpowers/plans/2026-05-22-shared-backend-ai-unification.md`
