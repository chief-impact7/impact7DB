# DSC UI/UX 선행 작업 이식 (2026-06-12, 커밋 f84a84e)

DSC 2026-06-11 UI/UX 감사 전달 사항을 DB에 적용 완료. 상세 기준:
`impact7newDSC/ui-ux-audit-2026-06-11.json`, `impact7newDSC/.memory/project_ui_ux_audit_2026-06-11.md`.

## DB에 적용된 자산
- **date-picker.js** — DSC 한국어 캘린더 이식본. DB 확장: shared `todayKST`, min/max(선택 시점 재검증), `input[type=date]` 전역 pointerdown 위임(마우스 좌클릭만 — 터치는 한국어 OS native 유지), 바깥 클릭 1회 swallow(모달 동시 닫힘 방지). **수정 시 DSC 사본과 상호 동기화 검토** — min/max·:disabled 스타일은 DSC 역이식 후보.
- Material Symbols `&display=block` (ligature FOUT 방지), 로그인 버튼 `aria-disabled` 로드 가드(+공통 CSS `[role=button][aria-disabled]`, a11y-keys가 aria-disabled 무시 방지 가드 보유), coarse pointer 44px 터치 타깃, 검색 범위 배너(`updateFilterChips` 내, "전체에서 검색"=clearFilters).

## DSC발 함정 (DB 코드 작업 시 항상 유효)
- `export { x } from '...'` re-export 전용 구문은 **자기 파일 스코프에 바인딩을 안 만든다** — 같은 파일에서 쓰면 빌드 통과 후 런타임 ReferenceError. 반드시 `import {...}; export {...};` 분리. 검증: dist/assets/*.js에서 bare 심볼 grep.
- 거대 innerHTML 조립에서 카드 함수 하나가 throw하면 패널 전체 미렌더 — 증상은 "특정 학생만 이전 패널 잔존".
- 위임 렌더 함수의 조용한 early return 금지 — 처리 여부 boolean 반환, false면 호출 측이 표준 렌더 계속.
- 반응형 브레이크포인트: <=768px 풀스크린, <=1100px 우측 오버레이 — CSS 변경 시 JS matchMedia(1100)도 함께.

## 인프라 (건드릴 때 주의)
- firebase-config.js 두 앱 체제: `[DEFAULT]`=auth 전담(원앱 SSO), `'db'` named app=Firestore 전담(persistence 분리 — 공유 시 탭 간 primary lease 충돌로 write hang). **단순화·이름 변경 금지.** 인스턴스는 반드시 config에서 import.
- shared 갱신은 `npm install "@impact7/shared@github:...#vX.Y.Z"` 명시 설치 (spec만 바꾸면 lock이 옛 커밋 유지). pre-push hook이 차단. 현재 v1.29.0 (합성 내신 enrollment가 학생 개별 naesin_days/schedule 반영).
- 검색 풀은 status 기반(DB 방식이 기준) — 변경 시 DSC list-view.js 검색 분기와 정합 유지.
- 프로덕션 클릭 검증 시 출석/지각 등 상태 버튼 절대 클릭 금지. 푸시 후 impact7-app.web.app 반영은 2~3분 시차.
