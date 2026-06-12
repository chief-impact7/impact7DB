# impact7exam / impact7HR UI/UX 개선 — DB·DSC 선행 작업 전달 프롬프트 (2026-06-12)

impact7DB에서 UI/UX 감사 35건 + 수정을 완료했다 (DSC 14건 선행 → DB 35건 완료).
같은 작업을 이 앱에서 진행하라. 아래는 재사용할 방법론, 점검 카탈로그, 반드시 피해야 할 함정이다.
상세 기준 문서: `impact7DB/ui-ux-checklist.json`(체크리스트 스키마 — 같은 형식으로 만들면 재감사·추적이 쉽다),
`impact7DB/.memory/project_dsc_uiux_handoff_2026-06-12.md`, DB 커밋 `2aab7fe`~`ae575c3`의 Lore 메시지.

## 0. 진행 방법 (DB에서 검증된 절차)

1. **감사**: 읽기 전용 분석 에이전트 3개 병렬 — ①비주얼/레이아웃/CSS 품질, ②인터랙션/피드백/에러 처리, ③접근성/반응형/시맨틱.
   "실제 코드에서 확인한 것만, 추측 금지" 조건으로. 결과를 `ui-ux-checklist.json`으로 저장:
   `{id, category, severity(high|medium|low), title, description, location(파일:줄), suggestion, effort(small|medium|large), done:false}`
   + `meta.summary` 카운트.
2. **배치 처리**: high → medium → low 순. effort large(다크모드·가상화·전면 리팩토링류)는 마지막 배치로 분리.
3. **배치마다**: 구현 → `node --check`/타입체크/빌드/단위테스트 → simplify → code-review(멀티 finder, 결함 반영) →
   품질 가드 마커 → Lore 형식 커밋(Rejected/Directive로 의도 기록). 완료 항목은 checklist에 `done:true, doneAt` + 보류는 `note`에 사유.
4. **이 앱은 vanilla가 아니다** (exam=Next.js+React, HR=SvelteKit+TS).
   DB의 vanilla 모듈(modal-manager.js, a11y-keys.js, form-enter.js 등)을 **복사하지 말고 패턴·계약만 프레임워크 관용구로 재구현**하라.
   진짜 `<button>`/`<dialog>`/컴포넌트를 쓰면 a11y-keys·모달 매니저류는 대부분 불필요하다 — "vanilla의 우회책"을 이식하지 말 것.

## 1. 점검 카탈로그 (DB 35건에서 일반화 — 감사 에이전트 프롬프트에 포함시킬 것)

**피드백/에러**: blocking `alert()`/`confirm()`/`prompt()` 사용처 전수(→ 토스트/모달, §3-1 함정 참조) · catch 후 사용자 미통지 침묵 실패 ·
저장 성공/실패 알림 일관성 · 미저장 변경 이탈 경고(beforeunload+라우트 전환 — SPA는 라우터 가드) · 초기 로딩 스켈레톤 · 0건 화면 회복 동선(검색어+필터 동시 초기화).
**인터랙션**: 제출/승인 버튼 연타 가드(in-flight) · 비동기 작업 중 모달 닫힘 차단(Esc·배경클릭·취소버튼 **3경로 모두**) ·
Enter 제출(checkbox/radio/date/IME 제외) · 키보드 Esc/포커스 트랩/포커스 복원 · native date input의 영문 캘린더(§2-1).
**비주얼/CSS**: 미정의 CSS 변수·클래스 참조(렌더 버그) · 시맨틱 색 토큰(--danger/--warn/--success 계열) 부재로 hex 난립 ·
같은 의미 색의 미세 드리프트 · chip/버튼 변형 중복 → 그룹 통합(클래스 개명 말고 셀렉터 그룹) · z-index 스케일 토큰 · radius 스케일(동일값만 치환) ·
인라인 스타일 반복 패턴 추출(상태 토글용 display 인라인은 유지) · 다크모드(토큰화 선행).
**접근성**: 클릭 div/span → 키보드 활성화 · label-input 연결(for/id, name 불변) · 장식 아이콘 aria-hidden · 아이콘 폰트 FOUT(`display=block`) ·
표 scope/aria-label · 저대비 텍스트(#888류) · 토스트 aria-live · 터치 타깃 44px(coarse pointer 한정) · role=button 내부 인터랙티브 요소 평탄화 주의.
**성능**: 긴 목록 전체 재렌더(React/Svelte는 key 안정성·메모이제이션이 우선, 가상화는 마지막) · 검색 디바운스 · 로그인 버튼 모듈 로드 가드.
**기타**: 검색 범위 배너(필터+검색 시 "전체에서 검색") · 죽은 파일/CSS 정리.

## 2. 재사용 자산 (패턴·계약 — DB 파일은 참고 구현)

1. **한국어 캘린더**: native `input[type=date]`는 브라우저 UI 언어(영문)를 따른다.
   `impact7newDSC/date-picker.js`의 `openKoreanDatePicker(anchorEl, valueStr, onSelect, {min, max})`는 의존성 없는 DOM 함수라
   **exam(React)은 ref로, HR(Svelte)은 action으로 그대로 래핑 가능** (DSC도 vanilla+React 대시보드가 공유 중).
   DB본(`impact7DB/date-picker.js`)에는 min/max·선택 시점 재검증·pointerType 가드가 추가돼 있음 — 이쪽을 기준으로.
   수정 시 DB/DSC 사본과 상호 동기화 검토.
2. **토스트 계약**: `showToast(message, type, {sticky})` — success/error/warn/info, error는 role=alert, aria-live 영역,
   **읽고 조치해야 하는 장문(차단 사유 목록·부분 실패 명단·진단 정보)은 sticky(수동 닫기)**. 채움 배경색은 테마 무관 고정값(§3-4).
3. **confirm/prompt 모달 계약**: Promise 기반, 취소/Esc/배경클릭 = null(confirm은 false). **다중 대상 일괄 작업만 모달, 단건은 native confirm 유지**.
4. **미저장 가드 계약**: dirty 추적(폼 입력 위임 + 폼 밖 모달이 폼 데이터를 바꾸면 명시적 markDirty) → beforeunload + 내비게이션/학생 전환/벌크 진입 시 확인.
   **가드를 우회해 폼을 숨기는 경로(벌크 모드 진입 등)를 전수 점검** — DB에서 실제로 뚫렸던 구멍.
5. **busy 가드 계약**: 비동기 쓰기 시작 시 모달에 busy 표시 → Esc·배경클릭·취소/X버튼 모두 차단, finally 해제. 제출 버튼 disabled는 별도로.
6. **다크모드**: 전면 토큰화 선행 → `[data-theme=dark]`에서 토큰만 재정의 + head 인라인 FOUC 방지(localStorage→OS 설정) + 토글 버튼.
   exam은 echarts 다크 테마 옵션 별도 처리, **인쇄/PDF 화면(성적표·급여명세서)은 라이트 강제**.
7. **기타 소형**: Material Symbols `<link>`에 `&display=block` · 로그인/주요 버튼 모듈 로드 전 aria-disabled 시작→할당 후 해제(키보드 경로도 차단되는지 확인) ·
   검색 범위 배너(DSC filter-nav / DB updateFilterChips 패턴).

## 3. 반드시 피해야 할 함정 (DB·DSC에서 실제로 터진 것)

1. **alert→toast 일괄 전환의 의미 소실**: alert는 blocking(반드시 읽음)이다. 장문 진단·차단 사유·부분 실패 명단을 5초 토스트로 바꾸면
   사용자가 놓친다 → sticky 필수. `window.open` 직후 안내문도 토스트면 새 탭에 있는 동안 사라진다.
2. **confirm→비동기 모달 전환의 blocking 소실**: 대기 중 다른 경로 재진입·상태 변경이 가능해진다.
   사전 계산한 변경분(스냅샷)이 stale해질 수 있고, 재진입 가드 위치가 confirm 앞/뒤로 갈리면 안 된다(가드 먼저).
3. **CRLF/혼합 줄바꿈 파일**: 도구 일괄 치환(python open().write(), Edit)이 전체를 정규화해 수천 줄 가짜 diff.
   수정 전 `file <경로>` 확인, diff가 부풀면 정규화만 별도 커밋으로 분리.
4. **이중 용도 토큰의 다크 함정**: 같은 토큰을 텍스트색+채움배경에 쓰면 다크에서 텍스트용으로 밝게 재정의하는 순간
   채움 위 흰 글자 대비가 추락. **흰 글자 채움색은 테마 무관 고정값**으로.
5. **일괄 치환이 토큰 정의 자체를 바꿈**: `#005c38 → var(--primary-hover)` 치환을 정의 추가 후에 돌리면
   `--primary-hover: var(--primary-hover)` 순환 참조(guaranteed-invalid). 치환 먼저, 정의는 나중에 삽입.
6. **IME(`isComposing`)**: 한글 조합 확정 Enter/조합 취소 Esc가 제출·모달 닫기를 오발화 — 모든 Enter/Esc 핸들러에 가드.
7. **Chromium select/date picker Esc 누출**: 드롭다운 닫는 Esc가 페이지로 전파돼 모달까지 닫음 — e.target 타입 가드.
8. **모바일 터치의 합성 mousedown**: 탭이 mousedown을 발화시켜 커스텀 피커+native가 동시에 뜸 — `pointerdown` + `pointerType==='mouse'` 가드.
9. **목록 가상화/청크 + "전체선택" 정합성**: 선택이 DOM 기준이면 미렌더 항목이 일괄 작업에서 조용히 누락(데이터 사고).
   선택 모드에서는 전체 렌더하거나 선택을 데이터 기준으로. IntersectionObserver 콜백은 `entries.some(isIntersecting)`(entries[0]만 보면 영구 멈춤).
10. **role=button 컨테이너 안의 checkbox 등은 보조기기에서 평탄화** — 선택 모드에선 role 분기 또는 생략.
11. **DSC발 (코드 작업 일반)**: `export {x} from '...'` re-export는 자기 스코프에 바인딩을 안 만듦(런타임 ReferenceError) ·
    거대 innerHTML 조립에서 한 함수 throw → 패널 전체 미렌더 · 위임 렌더의 조용한 early return 금지(boolean 반환).

## 4. 앱별·인프라 주의

- **exam**: Next.js 16 + React. SSR/hydration에서 다크모드 FOUC 방지는 next-themes류 또는 `_document` 인라인 스크립트.
  차트는 echarts 표준 유지(다른 라이브러리 금지), 다크 시 echarts 테마 별도. 채점/OCR 장시간 작업의 진행 표시·busy 가드가 고가치.
- **HR**: SvelteKit + TS. 급여·계약·인사 데이터 — **파괴적/금전 작업의 confirm 강화(대상 요약+작업명 버튼)가 최우선 항목**.
  급여명세서 등 인쇄 화면 라이트 고정. Svelte transition과 모달 가드 충돌 주의.
- **인프라 금기(두 앱 공통)**: firebase-config의 두 앱 체제([DEFAULT]=auth 공유 SSO, named app=Firestore persistence 분리)가 적용돼 있으면
  **단순화·앱 이름 변경 금지**, 인스턴스는 반드시 config에서 import. `@impact7/shared` 갱신은
  `npm install "@impact7/shared@github:chief-impact7/impact7-shared#vX.Y.Z"` 명시 설치(현재 v1.29.0).
  shared-first: 라벨/날짜/전화 표기 등은 `@impact7/shared` 모듈 우선, 학교+학부+학년 직접 문자열 조합 금지(`studentFullLabel`/`schoolLevelGradeLabel`).
  firestore.rules를 바꾸면 4-repo 동기화, storage.rules는 impact7DB에서만 배포(SSoT).
- **검증**: 프로덕션 클릭 검증 시 상태 변경 버튼 절대 클릭 금지(조회만). 푸시=자동 배포 여부를 이 repo의 워크플로에서 먼저 확인.
  소스 커밋 전 simplify → code-review → 품질 가드 마커 필수.
