---
name: project-hr-cleanroot-appcheck-domains
description: hr.impact7.kr 깔끔한 루트(impact7hr base='' 전용 사이트) + App Check reCAPTCHA 운영 도메인 등록
metadata:
  type: project
---

2026-06-22 두 가지 인프라 함정/해법.

## 1) 통합 호스팅 커스텀 도메인 토폴로지
- 운영 도메인 `*.impact7.kr`(db/dsc/hr/exam/app)은 **Cloudflare 프록시**가 각 앱의 서브경로를 **루트(/)에서** 서빙한다(예: hr.impact7.kr/ → 통합 호스팅 /hr 콘텐츠, 브라우저 URL은 / 유지).
- DB/DSC(Vite)·Dashboard는 루트에서 동작하지만 **HR(SvelteKit, base=/hr)** 은 브라우저 경로가 base로 시작해야 부팅 → `hr.impact7.kr/`(경로 /)에서 **무한로딩/freeze**. `hr.impact7.kr/hr/`는 정상.

## 2) HR 깔끔한 루트 해법 (사용자 선택: /hr 없이)
- HR을 **base=''** 로 빌드해 전용 사이트 **impact7hr**(impact7hr.web.app)에 배포 → 루트에서 깔끔하게 뜬다.
- 통합 `impact7-app.web.app/hr/`(base=/hr)는 허브 링크용으로 유지(이중 빌드).
- **drift 방지**: impact7hr 배포를 **통합 파이프라인(impact7-hosting/.github/workflows/deploy.yml)** 에 넣어 같은 커밋에서 함께 배포. impact7-app 배포 성공 후 단계라 실패해도 운영 무영향.
- HR `firebase.json` hosting: `_redirect` → `public:"build"` + SPA rewrite. (커밋 90ea5f1)
- **남은 사용자 작업(Cloudflare)**: hr.impact7.kr를 impact7hr.web.app로 직결(루트→/hr rewrite 제거). 이걸 해야 hr.impact7.kr 루트가 깔끔해짐.

## 3) App Check reCAPTCHA 도메인 (load-bearing)
- App Check enforce 시 운영 커스텀 도메인이 reCAPTCHA 키 allowedDomains에 없으면 토큰 `app:MISSING` → callable 401(auth는 VALID인데도).
- reCAPTCHA 키 `6LcS4ywt…`에 `impact7.kr, app/db/dsc/hr/exam.impact7.kr, *.web.app, firebaseapp.com, localhost` 등록 완료.
- 메시지/알림/출결/AI callable은 **DSC만** 호출(DB app.js 아님). DSC/HR에 App Check init 있음. tablet(tabletCheckin)은 미적용 → wave 2.
- 재적용 전 dsc/hr 새로고침 후 로그에서 `app:VALID` 확인 게이트. 상세: `docs/2026-06-21-impact7db-remediation/N-05-appcheck-rollout.md`.

연관: [[feedback-rules-sync-commit]] [[project-hr-permissions-quality-guard-2026-06-05]]
