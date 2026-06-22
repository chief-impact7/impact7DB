---
name: project-hr-cleanroot-appcheck-domains
description: hr.impact7.kr 깔끔한 루트(impact7hr base='' 전용 사이트) + App Check reCAPTCHA 운영 도메인 등록
metadata:
  type: project
---

2026-06-22 두 가지 인프라 함정/해법.

## 1) 생태계 서브도메인 라우팅 = Cloudflare Worker `impact7-proxy`
- `*.impact7.kr`(app/db/dsc/hr/exam/dash/logbook/message/survey/kakao/newtest)는 **DNS 더미(AAAA `100::`) + Workers Custom Domain** 으로 단일 Worker에 바인딩된다. Page Rule/Transform/Origin rule **없음** — 라우팅·경로매핑은 전부 Worker 코드.
- 소스: **impact7-hosting/proxy-worker/index.js** (`HOSTS` 맵). 배포: `cd proxy-worker && wrangler deploy`. 워커 이름 **impact7-proxy**(구 newtest-proxy에서 개명, 2026-06-22).
- 각 호스트는 루트(/)를 진입경로로 rewrite + 하위디렉토리 호스트엔 `<base href>` 주입. 주소창은 서브도메인 유지(프록시, 302 아님).

## 2) HR 깔끔한 루트 해법 (완료, /hr 없음)
- **HR(SvelteKit, base=/hr)** 은 브라우저 경로가 base로 시작해야 부팅 → 통합 `/hr` 콘텐츠를 루트(/)에서 주면 **무한로딩/freeze**(DB/DSC=Vite는 루트서 OK).
- 해법: HR을 **base=''** 로 전용 사이트 **impact7hr.web.app** 에 배포 + `impact7-proxy`의 hr 매핑을 `{ origin: impact7hr.web.app, root:"/", base:"/" }` 로 변경. → hr.impact7.kr/ 가 /hr 없이 깔끔하게 뜬다. (실브라우저 렌더 검증 완료)
- impact7hr 배포는 **통합 파이프라인(impact7-hosting/deploy.yml)** 이 HR 커밋마다 동기 배포(drift 방지). 통합 `impact7-app/hr`(base=/hr)도 허브 링크용으로 유지(이중 빌드).
- HR `firebase.json`: `_redirect` → `public:"build"`+SPA rewrite (90ea5f1). impact7-hosting 워커 이관 (04012fa).

## 3) App Check reCAPTCHA 도메인 (load-bearing)
- App Check enforce 시 운영 커스텀 도메인이 reCAPTCHA 키 allowedDomains에 없으면 토큰 `app:MISSING` → callable 401(auth는 VALID인데도).
- reCAPTCHA 키 `6LcS4ywt…`에 `impact7.kr, app/db/dsc/hr/exam.impact7.kr, *.web.app, firebaseapp.com, localhost` 등록 완료.
- 메시지/알림/출결/AI callable은 **DSC만** 호출(DB app.js 아님). DSC/HR에 App Check init 있음. tablet(tabletCheckin)은 미적용 → wave 2.
- 재적용 전 dsc/hr 새로고침 후 로그에서 `app:VALID` 확인 게이트. 상세: `docs/2026-06-21-impact7db-remediation/N-05-appcheck-rollout.md`.

연관: [[feedback-rules-sync-commit]] [[project-hr-permissions-quality-guard-2026-06-05]]
