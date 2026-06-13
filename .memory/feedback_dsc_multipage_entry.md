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

관련: [[feedback_module_separation]] (app.js 모듈 분리 — DB 기준), [[feedback_line_ending_edit]]
