# N-05 — App Check 롤아웃 계획 (비용 callable 보호)

> **결론 (2026-06-22): 의도적 미적용 — 추후 필요 시 진행.**
> App Check는 "외부 계정" 차단이 아니라 "진짜 앱이 아닌 클라이언트(스크립트·봇·토큰 도용 후 앱 외부 호출)"를 막는 기능이다.
> 핵심 위험인 **외부 계정의 유료/PII 접근은 이미 도메인 인증(assertAuthorizedStaff) + llmGenerate rate limit + 공개 토큰 CSPRNG·1회용·만료로 차단**됐다.
> App Check가 추가로 막는 시나리오(직원 토큰 탈취 후 스크립트 호출 등)는 사내 도구 특성상 확률이 낮고, reCAPTCHA 키(콘솔)+5앱 클라 init+영구 의존 비용이 크다.
> → 현 시점 **불필요**. 봇/스크래핑 방어를 강화하고 싶어질 때 아래 계획대로 진행한다. (reCAPTCHA는 App Check 전용 부품이라 그 전엔 발급 불필요.)

- 상태: 의도적 미적용 (자동 활성화 불가 — 콘솔 + 클라 선행)
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
