# DSC 멀티페이지 entry 함정 + app.js 일원화 (2026-06-14)

**핵심:** impact7newDSC는 **멀티페이지 앱**. 각 `*.html`이 독립 entry js를 로드한다. 전역 로직을 잘못된 entry 파일에 넣으면 그 페이지에서 **실행조차 안 된다**(빌드는 통과, 런타임 무동작).

## 페이지 ↔ entry (2026-06 일원화 후)
| 페이지 | entry js |
|--------|----------|
| index.html (메인) | `app.js` + `naesin.js` |
| excel.html | `excel.js` |
| dashboard.html | `src/dashboard/main.jsx` |
| class-setup.html | `class-setup.js` |
| checkin.html | `checkin.js` |

## 사건 경위
- `app.js` 역할이 앱마다 달랐다: **impact7DB=메인 entry**, **DSC=excel.html 전용**(구 메인 잔재).
- entry 전환 커밋(`e628274`)에서 index.html을 app.js→daily-ops.js로 바꾸며 **옛 app.js를 안 지웠다** → 이후 작업(#8 AI gear 등)이 죽은 app.js를 계속 수정 → 메인에서 작동 안 함.
- "gear 안 보임" 추적 순서: 권한·데이터·도메인 마이그레이션 정상 확인 → 배포 사고(자동배포가 구버전 업로드) → dataApp auth 미러(`dataAuthReady`) 누락 → **죽은 app.js(실제 entry는 daily-ops.js)** 가 진짜 원인.
- 해결: `daily-ops.js`→`app.js`, 옛 `app.js`→`excel.js` 일원화(DB와 동일 **app.js=메인**). `dsc-developer.md`·DSC `AGENTS.md`에 entry 매핑 명시.

## 규칙
- 코드 추가 전 대상 페이지의 `<script type="module" src>`로 entry를 확인한다.
- 전역 로직(로그인·헤더·권한·gear)은 메인 entry `app.js`에 둔다.
- **구 entry 파일은 전환 시 반드시 삭제**한다(안 지우면 이후 작업이 계속 헛다리).
- dataApp(named `'dsc'`) db로 권한성 문서(HR_users 등)를 읽을 땐 `dataAuthReady()`를 선행 await한다(미러 전 읽으면 permission-denied).

## 배포 구조 — 통합 호스팅 단일 경로 (2026-06-14 4개 앱 일원화)
DB/DSC/HR/DashBoard 모두 **자체 hosting 배포를 폐지**하고 통합(`impact7-hosting`)만 배포한다.
- 각 앱 `deploy.yml` = 통합 재빌드 **dispatch만**(빌드·자체배포 step 제거). `master`/`main` push → impact7-hosting이 4개 앱 checkout·빌드 → `impact7-app.web.app/{db,dsc,hr,dashboard}`.
- 자체 site(`impact7db`/`impact7dsc`/`impact7hr`/`impact7dashboard`.web.app)는 `impact7-app/{path}`로 **301 redirect만**(firebase.json `redirects` + `_redirect` 더미 public).
- **배포 경로 = push 하나**. 수동 `firebase deploy --only hosting`은 redirect site만 건드려 무의미 → 과거 이중배포 불일치 함정이 구조적으로 소멸(사람이 규칙 기억할 필요 없음).
- **단 functions는 별개 경로**: DB `functions:shared`/`leave-request`는 여전히 `firebase deploy --only functions:shared --project impact7db` 수동 배포(hosting 일원화와 무관).
- 배경: 2026-06 "구버전 배포"는 워크플로 사고가 아니라 죽은 app.js(코드 위치) + 이중배포 수동 불일치였다. 이중배포 자체를 없애 근본 해결.

관련: [[feedback_module_separation]] (app.js 모듈 분리 — DB 기준), [[feedback_line_ending_edit]]
