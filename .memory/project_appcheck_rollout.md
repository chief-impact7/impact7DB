# App Check 단계 적용 로드맵 (2026-07-05)

**현황:** 클라 초기화 완료 4/5 — DSC·HR(기존), **DB·tablet(2026-07-05 추가)**. exam 미적용(자체 서버 Vertex 직접이라 callable 미사용, Firestore 직접 write는 rules로 방어). 서버 callable은 전부 `enforceAppCheck: false`(무강제 — 토큰 발급·검증률 축적 단계).

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
