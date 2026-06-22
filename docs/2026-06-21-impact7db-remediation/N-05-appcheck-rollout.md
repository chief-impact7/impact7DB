# N-05 — App Check 롤아웃 (비용 callable 보호)

> **상태 (2026-06-22): 내부 callable enforce 완료·운영 반영. 공개/태블릿은 wave 2.**
> 카나리(llmGenerate) 실클라 검증(DSC AI 정상) 후 **내부 호출 callable 18종 enforce: true 배포**.
> - ✅ enforce ON: llmGenerate, generateStudentReportAi, runStudentReportBatchManual, createPromoCampaign,
>   setPromoConsent, sendParentNotice, getStudentMessages, sendDirectMessage, createBulkMessage,
>   syncChannelFriends, getChannelFriends, sendDailyReport, retryMessageDelivery, getMessageDeliveryStatus(이상 DSC),
>   hrUploadStaffDocument, hrUploadContract, hrUploadEntityDocument, hrDeleteFile(이상 HR 내부).
> - ⏸ enforce OFF(의도): getHrPublicToken·hrUploadSignedContract(공개 서명자 — 외부 기기 reCAPTCHA score 오탐 위험),
>   hrGetFileUrl(dual-use 다운로드, 공개 경로 포함), attendanceCheckin·tabletCheckin(tablet 미적용 — wave 2), sendKakao(stub).
> - **wave 2**: tablet appId App Check 등록 + tablet 클라 init → checkin류 enforce. 공개 서명은 reCAPTCHA score 모니터링 후 결정(또는 영구 OFF — 이미 토큰 CSPRNG·1회용·만료로 보호).

> **이전 상태 (참고): 진행 중 — 인프라+클라 완료, enforcement만 메트릭 검증 후 남음.**
> 사용자 결정으로 App Check 도입을 진행했다. 인프라(reCAPTCHA Enterprise 키 + impact7-web 등록)와
> 클라 init(DSC·HR, 미강제)을 운영 배포했다. **이제 토큰이 흐른다(미강제).**
> 남은 것은 ① 실트래픽으로 App Check 메트릭이 verified 100%인지 확인 → ② callable별 enforceAppCheck 플립.
> **블라인드 enforce 금지**: reCAPTCHA 오설정(도메인/score)이면 신규 클라까지 깨지므로, 메트릭 확인 전 켜지 않는다.

## 완료 (운영 반영)
- reCAPTCHA Enterprise 키: `6LcS4ywtAAAAADd8BBiFo_Fd4XXiXT1Uf3gHGxYl` (score, 도메인 impact7-app.web.app·impact7db.web.app·firebaseapp.com·localhost).
- App Check 등록: **impact7-web** appId(1:485669859162:web:2cfe866520c0b8f3f74d63 — DB/DSC/HR 공유)에 reCAPTCHA Enterprise provider(tokenTtl 1h, minScore 0.5).
- 클라 init 배포: **DSC**(firebase-config.js dataApp) + **HR**(config.ts dataApp, 공개페이지 포함). 둘 다 미강제, 토큰 발행 중.

## 남은 단계 (enforcement runbook)
1. **메트릭 확인**: Firebase 콘솔 App Check 또는 API로 impact7-web의 verified/unverified 비율 확인. 실사용자가 새 클라를 받아 verified가 충분히(>~95%) 오를 때까지 대기(보통 1일 내 — 사용자 새로고침).
   - 로컬 개발용 디버그 토큰: DSC/HR을 localhost로 열면 콘솔에 디버그 토큰 출력 → App Check 콘솔에 등록해야 로컬서 verified.
2. **callable별 enforce 플립**(functions-shared/index.js `enforceAppCheck: false`→`true` + 배포). 권장 순서(저위험→):
   - llmGenerate(카나리, DSC만·비핵심) → generateStudentReportAi·runStudentReportBatchManual → getHrPublicToken·hrUpload*·hrGetFileUrl(HR) .
   - **주의**: attendanceCheckin·tabletCheckin은 tablet도 호출 → tablet 앱 init+등록(아래 wave 2) 전엔 enforce 금지.
   - 각 플립 후 해당 기능 1건 smoke. 문제 시 그 callable만 false로 롤백.
3. **Wave 2 — tablet/exam**: tablet은 자체 appId(impact7-web 아님) → App Check 등록 + tablet 클라 init 후 tabletCheckin/checkin enforce. exam도 호출 callable 있으면 동일.

## 비고
- 외부 계정/PII는 이미 도메인 인증+rate limit+CSPRNG로 차단됨(App Check는 봇/토큰도용 앱외부호출 보강).
- reCAPTCHA Enterprise: 월 1만 평가 무료 → 학원 규모 무료권 내 예상.

- 상태: 인프라·클라 완료 / enforcement 대기(메트릭 검증 후)
- 대상: 비용/민감 callable(llmGenerate, generateStudentReportAi, runStudentReportBatchManual, sendKakao, hrUpload*/getHrPublicToken 등). 현재 전부 `enforceAppCheck: false`.

## 왜 지금 못 켜나 (load-bearing)

`onCall({ enforceAppCheck: true })`로 바꾸면 **App Check 토큰을 첨부하지 않는 모든 호출이 거부**된다. 현재 호출자(DSC·HR·tablet·DB 웹앱)는 App Check SDK를 초기화하지 않으므로, 켜는 즉시 DSC AI·HR 온보딩/서명/업로드·태블릿 출결이 전부 깨진다. 따라서 **콘솔 등록 + 전 호출 앱 클라 init이 끝난 뒤** 단계적으로 켜야 한다.

## 롤아웃 순서

1. **reCAPTCHA 키 발급(콘솔/gcloud)** — 웹앱용 reCAPTCHA Enterprise(또는 v3) 사이트 키 생성.
   - `gcloud recaptcha keys create --web --domains=impact7-app.web.app --integration-type=score` (또는 콘솔).
2. **Firebase App Check에 앱 등록** — 콘솔 App Check에서 각 웹앱(DB/DSC/HR/exam/tablet)에 reCAPTCHA provider + 사이트 키 등록. 디버그 토큰도 발급(로컬 개발용).
3. **클라 init 추가(전 호출 앱)** — 각 앱 부트스트랩에:
   ```js
   import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
   initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(SITE_KEY), isTokenAutoRefreshEnabled: true });
   ```
   - DB(app.js), DSC, HR(config.ts), tablet, exam — callable을 호출하는 모든 앱.
4. **모니터링(미강제) 기간** — App Check를 켜기 전, 콘솔 App Check 메트릭에서 "verified vs unverified" 비율을 본다. 모든 트래픽이 verified가 될 때까지 대기(클라 배포 전파).
5. **callable별 단계적 enforcement** — verified 100% 확인 후 callable 하나씩 `enforceAppCheck: true`로 전환·배포·관찰. 우선순위: llmGenerate → studentReportAi/batch → HR 업로드 → 출결.
6. **롤백** — 문제 시 해당 callable만 `enforceAppCheck:false`로 즉시 재배포.

## 콘솔 의존(사용자/관리자 필요)
- reCAPTCHA 사이트 키 생성, Firebase App Check 앱 등록·디버그 토큰 — 코드로 자동화 불가(콘솔 권한). 이 두 가지가 선행돼야 클라 init이 의미를 가진다.

## 현재까지의 비용-악용 방어(App Check 없이 적용됨)
- llmGenerate: assertAuthorizedStaff(외부 도메인 차단) + per-uid rate limit(30/60s) — H-02 해소.
- 그 외 AI callable(studentReportAi/batch): assertAuthorizedStaff/assertDirector로 직원·원장 게이트(외부 차단). per-uid quota는 미적용(인사이더 리스크만 남음) — App Check 또는 별도 rate limit로 보강 가능.

## 권고
App Check는 별도 집중 작업(콘솔 키 + 5앱 클라 init + 모니터링 + 단계 enforcement)으로 진행. 그 전까지 외부 악용은 도메인 인증으로 차단돼 있고, 남은 건 인사이더(직원 계정) 남용뿐이다. 인사이더 비용 남용이 우려되면 App Check 대기 중 임시로 studentReportAi에도 per-uid rate limit을 추가하는 것이 가장 빠른 보강이다.
