---
name: project-hr-cleanroot-appcheck-domains
description: hr.impact7.kr 깔끔한 루트(impact7hr base='' 전용 사이트) + App Check reCAPTCHA 운영 도메인 등록
metadata:
  type: project
---

2026-06-22 두 가지 인프라 함정/해법.

## 1) 생태계 서브도메인 라우팅 = Cloudflare Worker `impact7-proxy`
- `*.impact7.kr`(app/db/dsc/hr/exam/dash/logbook/message/forms/survey/kakao/newtest)는 **DNS 더미(AAAA `100::`) + Workers Custom Domain** 으로 단일 Worker에 바인딩된다. Page Rule/Transform/Origin rule **없음** — 라우팅·경로매핑은 전부 Worker 코드.
- 소스: **impact7-hosting/proxy-worker/index.js** (`HOSTS` 맵). 배포: `cd proxy-worker && wrangler deploy`. 워커 이름 **impact7-proxy**(구 newtest-proxy에서 개명, 2026-06-22).
- 각 호스트는 루트(/)를 진입경로로 rewrite + 하위디렉토리 호스트엔 `<base href>` 주입. 주소창은 서브도메인 유지(프록시, 302 아님).
- **개명/이관 검증 완료(2026-06-22)**: 옛 `newtest-proxy` 워커는 Cloudflare 계정에 **부재**(`wrangler deployments list --name newtest-proxy` → code 10007) — 잔존 워커로 인한 custom domain 바인딩 충돌 없음. `impact7-proxy` 단일 워커가 전 도메인 서빙. 개명·폴더이관은 워커 식별자·소스 위치만 바꾼 것이라 라우팅 로직·바인딩·origin 매핑 불변 → 앱 영향 없음.
- **forms.impact7.kr 합류 + custom domain 함정(2026-06-22, 재발 주의)**: 신규 서브도메인은 `wrangler.toml` routes에 `custom_domain = true` 추가 + `index.js` `HOSTS` 매핑 + `firebase.json` rewrite(`/forms`→`/forms-admin/index.html`, `/forms/**`·`/forms-admin/api/**`→Cloud Run `impact7-forms-api`)가 한 세트. **함정**: `custom_domain` route를 추가하고 `wrangler deploy`해도 **첫 배포에서 Custom Domain(=DNS 레코드) 생성이 조용히 누락**될 수 있다(워커 코드 업로드는 성공 처리 → `forms.impact7.kr` NXDOMAIN). **해법: `wrangler deploy` 한 번 더 실행** → trigger 목록에 `forms.impact7.kr (custom domain)` 생성됨. 또 새 도메인은 직후 로컬 macOS `mDNSResponder` negative 캐시로 시스템 `curl`이 잠시 `000`(실서비스는 정상 — `--resolve`로 직접연결 시 200·SSL OK로 확인). 즉시 풀려면 `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`. 11개 서브도메인 라이브 **전부 200** 검증완료.

## 2) HR 깔끔한 루트 해법 (완료, /hr 없음)
- **HR(SvelteKit, base=/hr)** 은 브라우저 경로가 base로 시작해야 부팅 → 통합 `/hr` 콘텐츠를 루트(/)에서 주면 **무한로딩/freeze**(DB/DSC=Vite는 루트서 OK).
- 해법: HR을 **base=''** 로 전용 사이트 **impact7hr.web.app** 에 배포 + `impact7-proxy`의 hr 매핑을 `{ origin: impact7hr.web.app, root:"/", base:"/" }` 로 변경. → hr.impact7.kr/ 가 /hr 없이 깔끔하게 뜬다. (실브라우저 렌더 검증 완료)
- impact7hr 배포는 **통합 파이프라인(impact7-hosting/deploy.yml)** 이 HR 커밋마다 동기 배포(drift 방지). 통합 `impact7-app/hr`(base=/hr)도 허브 링크용으로 유지(이중 빌드).
- HR `firebase.json`: `_redirect` → `public:"build"`+SPA rewrite (90ea5f1). impact7-hosting 워커 이관 (04012fa).
- **함정(SW 캐시)**: HR엔 `static/sw.js` 서비스워커(network-first지만 `fetch(req)`가 HTTP 캐시 존중)가 있어, base 변경 후 옛 base=/hr 셸이 HTTP/SW 캐시에서 서빙돼 **무한로딩**. 수정: CACHE_NAME v1→**v2**(activate에서 옛 캐시 삭제) + 내비게이션 `cache:'reload'`로 HTTP 캐시 우회·미캐시 (4dd79c4). **사용자측은 1회 'Clear site data'** 필요(옛 SW 제거). SPA base 경로 변경 시 SW 캐시명 bump 필수 교훈.

## 3) App Check enforce — 영구 보류 (확정: 한 번도 작동 안 함)
- **근본 원인**: reCAPTCHA Enterprise 키 충돌. 페이지에 ①App Check `enterprise.js?render=<siteKey>` ②**Firebase Auth `enterprise.js?render=explicit`**(firebase ^12.15, Auth reCAPTCHA Enterprise 활성)가 둘 다 로드 → Auth가 먼저 로드돼 App Check 키가 grecaptcha에 미등록 → `execute()` "Invalid site key or not loaded" → 토큰 0 → 모든 callable **`app:MISSING`**.
- 도메인 등록(reCAPTCHA 키 allowedDomains에 *.impact7.kr·*.web.app)·Firebase App Check 앱등록·번들 init은 전부 정상 — **충돌만이 원인**. 과거 enforce가 깨진 진짜 이유(canary 성공도 착시).
- **현 상태**: enforceAppCheck 전면 OFF(안전). 외부 악용은 도메인인증+rate limit+CSPRNG로 차단 중. App Check는 봇/토큰도용 보강분.
- **재개 조건**: Auth/App Check 같은 reCAPTCHA 키 정렬(또는 Auth reCAPTCHA 재검토/로드순서 제어) → **staging에서 `app:VALID` 실발급 확인 후에만** enforce. blind enforce 금지. 상세: `docs/2026-06-21-impact7db-remediation/N-05-appcheck-rollout.md`.

연관: [[feedback-rules-sync-commit]] [[project-hr-permissions-quality-guard-2026-06-05]]
