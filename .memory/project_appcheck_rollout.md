# App Check — 도입 보류 (사용자 결정 2026-07-05)

**⛔ 결정: App Check 클라 init을 확대하지 않는다.** reCAPTCHA Enterprise 스크립트 로드·토큰 교환이 각 앱의 **초기 반응속도를 체감되게 깎는데**, 서버 callable이 전부 `enforceAppCheck: false`라 보안 이득이 0이기 때문(사용자가 과거에 이미 같은 이유로 도입하지 않기로 결정했음). 2026-07-05 DB·tablet에 잠시 추가했다가 **같은 날 제거**(DB 커밋 참조). **AI/에이전트는 App Check 도입을 재제안하지 말 것 — 사용자가 먼저 요청할 때만.**

**현황:** 클라 초기화 DSC·HR만 잔존(기존부터 있던 것 — 제거 여부는 사용자 판단 대기). DB·exam·tablet 미적용. 서버 전부 무강제.

아래 로드맵은 **사용자가 나중에 도입을 원할 경우에만** 유효한 참고 자료다.

**공용 reCAPTCHA Enterprise 키:** `6LcS4ywtAAAAADd8BBiFo_Fd4XXiXT1Uf3gHGxYl` (4개 앱 공용)

**enforce 전환 전 필수 확인(콘솔 작업 — 사람):**
1. reCAPTCHA Enterprise 키에 도메인 등록: `*.impact7.kr` + `impact7db.web.app` + 태블릿 접속 도메인. 누락 시 `app:MISSING` 401 함정([[project_hr_cleanroot_appcheck_domains]]).
2. Firebase 콘솔 → App Check → 각 callable의 요청 검증률(verified %) 확인 — 95%+ 며칠 유지 후 전환.
3. 로컬 개발: localhost는 디버그 토큰(`FIREBASE_APPCHECK_DEBUG_TOKEN=true`) — 콘솔에 디버그 토큰 등록 필요.

**전환 순서(낮은 위험 → 높은 위험):**
1. 저위험 read형: getMessageDeliveryStatus, getRecipientMessageHistory
2. HR 파일: hrGetFileUrl, hrUpload* (HR만 호출, HR은 App Check 됨)
3. AI 과금: llmGenerate, generateStudentReportAi (DSC 호출)
4. 발송류: sendParentNotice, sendDirectMessage, createBulkMessage, createPromoCampaign
5. 체크인: tabletCheckin, staffCheckin, attendanceCheckin — **tablet 배포판이 App Check init 포함 버전인지 먼저 확인**
- 예외 유지: getHrPublicToken 등 비로그인 공개 토큰 callable은 별도 검토(공개 페이지도 App Check 토큰은 발급됨 — HR init이 공개 라우트 커버하는지 확인 후)

**전환 방법:** functions-shared/index.js 각 onCall의 `enforceAppCheck: false → true`, 카나리로 1~2개씩. llmHandler의 인스턴스별 rate limit은 App Check와 별개로 유지.
