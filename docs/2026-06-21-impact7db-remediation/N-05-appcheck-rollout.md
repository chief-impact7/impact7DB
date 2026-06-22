# N-05 — App Check 롤아웃 (비용 callable 보호)

> **확정 결론 (2026-06-22): App Check는 한 번도 작동한 적 없음 — reCAPTCHA 키 충돌. enforce 영구 보류.**
>
> 도메인 추가 후에도 실사용자(dsc.impact7.kr) 트래픽이 전부 `app:MISSING`(auth:VALID). 브라우저에서 직접
> `grecaptcha.enterprise.execute(6LcS4ywt…)` → **"Invalid site key or not loaded in api.js"**.
>
> **근본 원인**: 페이지에 reCAPTCHA Enterprise가 **두 소비자**로 로드됨 —
> ① App Check `enterprise.js?render=<siteKey>` ② **Firebase Auth `enterprise.js?render=explicit`**(firebase ^12.15, Auth reCAPTCHA Enterprise 활성).
> Auth가 render=explicit로 먼저 로드 → 동일 enterprise.js가 이미 있다고 판단돼 **App Check의 키가 grecaptcha에 등록되지 않음** → App Check 토큰 발급 실패 → 모든 비용/민감 callable `app:MISSING`.
> 검증 완료: 키 도메인 등록 OK / Firebase App Check 앱 등록(siteKey·tokenTtl·minScore0.5) OK / 배포 번들에 App Check init OK — **충돌만이 원인**.
>
> **그래서 과거 enforce가 전부 깨졌던 것**(canary "성공"도 착시 — 로그는 항상 MISSING).
>
> **수정 방향(별도 집중 작업 필요, 운영 블라인드 금지)**: Auth와 App Check가 **같은 reCAPTCHA Enterprise 키**를 쓰게 정렬하거나(Firebase 권장), Auth reCAPTCHA Enterprise 사용 여부 재검토, 또는 init 로드 순서/명시 render 제어. staging 빌드에서 `app:VALID` 실발급 확인 후에만 enforce.
> **현 상태**: enforce 전면 OFF 유지(안전). 외부 악용은 도메인 인증+rate limit+CSPRNG로 이미 차단 — App Check는 봇/토큰도용 보강분.
>
> ---


> **근본원인 정정 (2026-06-22): enforce 직후 운영 장애 → 전면 롤백(enforce off) → 진짜 원인 확정 후 reCAPTCHA 도메인 수정.**
>
> **장애 증상:** enforce ON 직후 dsc.impact7.kr에서 학부모알림 작성·메시지 탭 조회·등원이 모두 `unauthenticated`(HTTP 401). AI(llmGenerate)는 됐다는 보고가 있었으나 실제로는 동일 인스턴스라 같이 깨졌어야 함.
>
> **확정 증거 (Cloud Logging, getStudentMessages 401):**
> ```
> jsonPayload: { message: "Callable request verification passed",
>                verifications: { app: "MISSING", auth: "VALID" } }
> httpRequest: { status: 401, referer: "https://dsc.impact7.kr/" }
> ```
> → **auth는 VALID, App Check 토큰만 MISSING.** 호출 출처가 **커스텀 도메인 `dsc.impact7.kr`**인데, reCAPTCHA Enterprise 키 allowedDomains엔 `impact7-app.web.app/impact7db.web.app/firebaseapp.com/localhost`만 있어 **운영 커스텀 도메인이 전부 누락** → 그 도메인에선 reCAPTCHA가 토큰을 발급 못 함 → App Check MISSING → enforce가 401.
>
> **오진 정정:** "DB app.js·tablet이 호출자라 init 누락" 가설은 틀림. 실제 메시지/알림/출결/AI callable은 **DSC만** 호출(`data-layer.js`·`checkin.js`, 모두 App Check 붙은 `functions=getFunctions(dataApp,'asia-northeast3')` 공유). DB 프론트는 functions-shared callable을 호출하지 않음(Firestore 직접). 따라서 DB엔 App Check init 불필요. tablet은 `tabletCheckin`만 호출(현재 enforce OFF).
>
> **수정 (2026-06-22 적용):** reCAPTCHA 키(6LcS4ywt…) allowedDomains에 운영 도메인 추가 →
> `impact7.kr, app/db/dsc/hr/exam.impact7.kr, impact7-app/db/dsc/hr/tablet.web.app, firebaseapp.com, localhost`.
> enforce는 OFF 유지 — **dsc/hr에서 새로고침해 토큰이 app:VALID로 발급되는지 로그로 확인한 뒤** 단계적 재적용.
>
> ---
>
> **이전 상태 (2026-06-22): 내부 callable enforce 완료·운영 반영. 공개/태블릿은 wave 2.** (← 도메인 누락으로 롤백됨)
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
