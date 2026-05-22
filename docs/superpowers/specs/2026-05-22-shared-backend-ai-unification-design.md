# 공유 백엔드 — AI 인증 통일 + 카카오/출결/결제 기반 설계

- 작성일: 2026-05-22
- 호스트 repo: impact7DB (공유 백엔드 SSoT)
- 관련 repo: impact7exam, impact7newDSC
- 관련 메모리: `.memory/project_shared_backend_foundation.md`

## 1. 배경 & 목표

DSC/DB/HR/exam이 공유할 횡단 백엔드 서비스를 impact7DB의 Cloud Functions(`shared` codebase)에 둔다. 현재 AI 호출 방식이 앱마다 갈려 있다:

- **exam**: 서버사이드, Gemini Developer API(AI Studio), **API 키** 인증. 4개 모듈에서 사용.
- **DSC**: 클라이언트사이드, Vertex AI(GCP), Firebase AI Logic. functions 슬롯 없음.

이 비대칭을 **서버 + Vertex AI + ADC** 로 통일하고, 카카오·출결·결제 공유 서비스가 나중에 로직만 붙이면 되도록 기반 배관을 깐다.

### 범위 (2026-05-22 확정)
- **지금 실구현 + 배포**: AI 호출 통일 (exam 전환 + DSC 전환 + 공유 게이트웨이)
- **지금 기반만 (중간 깊이)**: 카카오·출결·결제 — 함수 골격·공통 유틸 골격·Firestore 스키마·클라 래퍼·Secret 슬롯. 실 로직은 나중.

## 2. 핵심 설계 결정

| 항목 | 결정 |
|------|------|
| 인증 | exam·DSC·게이트웨이 모두 **ADC + Vertex AI**. 코드에서 API 키 제거 |
| SDK | `@google/genai` vertexai 모드로 통일 (`new GoogleGenAI({ vertexai: true, project: 'impact7db', location: 'global' })`) |
| 경로 | **하이브리드** — exam=자체 Next 서버에서 직접 Vertex / DSC·향후 앱=공유 게이트웨이 Callable |
| location | `global` (DSC 기존 `VertexAIBackend('global')`와 일치, 모델 가용성 넓음) |
| 배포 | 이번 작업에 포함 (`firebase deploy --only functions:shared`, IAM, Secret) |

**하이브리드 근거:** exam은 이미 성숙한 retry/fallback과 무거운 vision 호출(대용량 base64, 65536 토큰)이 있어, 게이트웨이 경유 시 함수 페이로드/타임아웃/콜드스타트 부담이 큼. exam은 이미 서버이므로 SDK만 교체하면 통일 목표(키 제거·Vertex·ADC) 달성. DSC는 서버가 없어 게이트웨이가 필요. → "코드 공유"가 아니라 "인증·SDK·모델 규약 통일".

## 3. 트랙 A — AI 통일 (실구현)

### A-1. 공유 게이트웨이 (`functions-shared/`)
- **`llmGenerate`** — Callable function.
  - 입력: `{ prompt: string, model?: string, config?: {...} }` (멀티모달은 추후 옵션, DSC는 텍스트만)
  - 검증: Firebase Auth(`request.auth` 필수) + App Check enforce
  - 비용 가드: 호출자별 rate limit, 호출 로깅 (메모리 `feedback_no_autonomous_batch` — 비용 사고 교훈)
  - 인증: ADC → `@google/genai` vertex 모드로 Vertex 호출
  - 출력: `{ text: string, model: string }`

### A-2. exam (4개 모듈 전환)
대상 파일 (모두 `impact7exam/src/server/`):
- `ai/gemini.ts` — 텍스트
- `ai/vision.ts` — 비전 단일/멀티
- `growth-report/commentary.ts` — JSON 스키마 + thinkingConfig
- `analyses/generate.ts` — 이미 `@google/genai`, vertex 모드로 전환 (가장 쉬움)

변경:
- REST `fetch(...?key=GEMINI_API_KEY)` → `@google/genai` vertex 모드 클라이언트
- `responseSchema`, `thinkingConfig`, 멀티이미지(`inlineData`), `maxOutputTokens`, `finishReason` 처리가 SDK에서 동일 동작하는지 **구현 시 context7로 확인**
- `retry.ts`의 retry/fallback 정책 유지
- App Hosting 런타임 SA에 `roles/aiplatform.user` 부여 (env에서 `GEMINI_API_KEY` 제거)

### A-3. DSC (게이트웨이 전환)
대상 파일 (`impact7newDSC/`):
- `firebase-ai.js` — 클라 Vertex(`firebase/ai`) 제거 → 게이트웨이 Callable 호출 래퍼로 교체
- `gemini-queue.js`, `parent-message.js` — `geminiModel.generateContent(prompt)` → 래퍼 함수로 교체
- DSC `firebase.json`에는 functions 슬롯을 두지 않음 (게이트웨이는 impact7DB 소유)

## 4. 트랙 B — 카카오/출결/결제 기반 (중간 깊이)

`functions-shared/` 안에:

### B-1. 함수 골격 (no-op export, 본문 미구현)
| 함수 | 트리거 | 미구현 처리 |
|------|--------|-------------|
| `sendKakao` | Callable | `throw HttpsError('unimplemented')` |
| `paymentHook` | HTTP 웹훅 | 503 + 로그 |
| `onAttendance` | `onDocumentWritten` | 로그만 |

### B-2. 공통 유틸 골격 (인터페이스/타입만)
- 멱등키 처리 (`idempotency.js`)
- 웹훅 서명검증 인터페이스 (`verifySignature.js`)
- 발송 로깅 헬퍼 (`notifyLog.js`)

### B-3. Firestore 스키마 정의
- `notification_logs` — 발송 이력 (채널, 수신자, 템플릿, 상태, ts)
- `payment_records` — 결제 기록 (주문ID, 금액, 상태, 멱등키, 서명검증결과)
- `firestore.rules`에 두 컬렉션 슬롯 추가 (서버 전용 쓰기)

### B-4. 각 앱용 클라 래퍼 + Secret 슬롯
- 각 앱이 `sendKakao` 등을 부를 얇은 클라 래퍼 (구현은 트랙 A의 `llmGenerate` 래퍼와 동일 패턴)
- Secret Manager 네이밍: `kakao-api-key`, `pg-secret-key` (빈 placeholder 등록)

## 5. 배포 & GCP 설정

순서:
1. Vertex AI API(`aiplatform.googleapis.com`) enable 확인
2. IAM: exam App Hosting SA + `functions-shared` 런타임 SA에 `roles/aiplatform.user`
3. Secret 슬롯 등록 (빈 placeholder)
4. `firebase deploy --only functions:shared --project impact7db` — **이 스코프로만 배포**
5. exam은 자체 App Hosting 파이프라인으로 배포 (apphosting.yaml)

**클로버링 안전장치:** `--only functions:shared`만 사용. leave-request codebase, HR default codebase 미관여 (codebase 분리되어 충돌 없음).

## 6. 테스트 전략
- 게이트웨이 `llmGenerate`: 단위 테스트(인증 거부/rate limit), 에뮬레이터 통합 테스트
- exam 4개 모듈: 기존 테스트 유지, Vertex 응답 mock으로 회귀 확인
- DSC: 게이트웨이 래퍼 호출 경로 수동 확인 (학부모 메시지 생성, gemini-queue)

## 7. 미해결 사항 (구현 단계에서 확정)
- **모델명 매핑**: exam `gemini-3-flash-preview`/`gemini-2.5-pro`/`gemini-2.5-flash`, DSC `gemini-3.5-flash` → Vertex 카탈로그 실제 모델명. context7 + Vertex 모델 목록으로 확인.
- `@google/genai` vertex 모드에서 `responseSchema`/`thinkingConfig`/멀티이미지 지원 여부.
- 게이트웨이 rate limit 구체 임계값.
- App Check enforce가 DSC 현재 등록 상태와 호환되는지.

## 8. 비범위 (이번에 안 함)
- 카카오·결제·출결의 실제 발송/검증 로직
- 실 API 키·PG 시크릿 값 발급
- 멀티모달 게이트웨이(이미지) — DSC가 텍스트만 쓰므로 추후
