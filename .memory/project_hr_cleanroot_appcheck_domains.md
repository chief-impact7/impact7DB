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

## 3) App Check enforce — 영구 보류 (확정: 한 번도 작동 안 함)
- **근본 원인**: reCAPTCHA Enterprise 키 충돌. 페이지에 ①App Check `enterprise.js?render=<siteKey>` ②**Firebase Auth `enterprise.js?render=explicit`**(firebase ^12.15, Auth reCAPTCHA Enterprise 활성)가 둘 다 로드 → Auth가 먼저 로드돼 App Check 키가 grecaptcha에 미등록 → `execute()` "Invalid site key or not loaded" → 토큰 0 → 모든 callable **`app:MISSING`**.
- 도메인 등록(reCAPTCHA 키 allowedDomains에 *.impact7.kr·*.web.app)·Firebase App Check 앱등록·번들 init은 전부 정상 — **충돌만이 원인**. 과거 enforce가 깨진 진짜 이유(canary 성공도 착시).
- **현 상태**: enforceAppCheck 전면 OFF(안전). 외부 악용은 도메인인증+rate limit+CSPRNG로 차단 중. App Check는 봇/토큰도용 보강분.
- **재개 조건**: Auth/App Check 같은 reCAPTCHA 키 정렬(또는 Auth reCAPTCHA 재검토/로드순서 제어) → **staging에서 `app:VALID` 실발급 확인 후에만** enforce. blind enforce 금지. 상세: `docs/2026-06-21-impact7db-remediation/N-05-appcheck-rollout.md`.

연관: [[feedback-rules-sync-commit]] [[project-hr-permissions-quality-guard-2026-06-05]]
