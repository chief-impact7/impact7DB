# DB 구현 결과 — 학생 표시 통일 (Phase: DB)

스펙: `_workspace/01_db_spec.md` / 공유 모듈 `@impact7/shared/enrollment-status` v1.4.0
상태: 구현·simplify·review·빌드 완료. **커밋/푸시 안 함** (사용자 실화면 확인 대기).

## 변경 파일

### app.js
- **L8 import**: `studentCategory, STATUS_TONE, STUDENT_STATUS_GROUPS` 추가 (기존 enrollment-status 줄에).
- **L161-163 신규 헬퍼** (`escAttr` 아래):
  - `statusToneClass(status)` → `STATUS_TONE[status]` 있으면 `'tone-' + tone`, 없으면 `''`.
  - `statusBadgeHtml(status)` → `<span class="item-status tone-…">status</span>`, status 없으면 `''`.
  - 배지 생성 로직이 4곳에 중복돼 simplify 단계에서 헬퍼로 통합.
- **renderStudentList (L1283~)** 기본 경로(grouped 아님 + expected 아님) 2계층 분리:
  - `enrolled` = `studentCategory(s.status)==='재원생'`, `nonEnrolledInList` = `'비원생'`.
  - 비원생 = `nonEnrolledInList + pastResults` id dedup → 단일 비원생 섹션.
  - 재원생 있으면 `group-header`("재원생 N명") + `renderStudentItem`. 비원생은 `renderPastStudentResults`(헤더 "비원생" 재사용).
  - grouped 뷰·expected 필터 뷰는 현행 유지(별도 `renderPastStudentResults(pastResults)` 호출 그대로).
- **renderStudentItem (L1383)**: 하드코딩 statusClass 삼항 삭제 → `statusBadge = statusBadgeHtml(status)`. (`status` 변수는 휴원종료일 분기에서도 쓰여 유지)
- **renderPastStudentItem (L1461)**: 하드코딩 `"비원생"/st-contact` → `statusBadgeHtml(s.status || '')` (실제 status: 상담/퇴원/종강 표시).
- **selectStudent — profile-status (L1748-1750)**: textContent + `className = 'item-status '+statusToneClass(...)`.trim() (헤더 배지 tone).
- **selectStudent — detail-status (L1764-1765)**: `innerHTML = statusBadgeHtml(...) || '—'` (수업정보 카드 배지 tone).

### index.html
- **L531 profile-status**: `class="tag tag-status"` → `class="item-status"` (초기 placeholder 일관성; tone은 JS가 부여).

### style.css
- **L2104~ tone 6종 신규** (스펙 hex 그대로 — DSC 미러용 SSoT):
  `.tone-active/.tone-scheduled/.tone-paused/.tone-consult/.tone-ended-hard/.tone-ended-soft`.
- **삭제**: `.st-active/.st-scheduled/.st-paused/.st-withdrawn`(L2112~) + `.item-status.st-contact`(L1166).
- **유지**: `.item-status` 베이스(L2100), `.tag-status`(L909, past-history.js가 사용).

## 빌드 결과
`npx vite build` 성공 — `31 modules transformed`, `built in 1.97s`.
출력: index.html 72.07kB / index.css 51.55kB / index.js 511.35kB(gzip 153.68kB).
경고는 기존부터 있던 청크 크기(>500kB)·help-guide.js 비-모듈 스크립트 건으로 이번 변경과 무관.

## 비원생 섹션 / pastResults 중복 처리 설명
기본 경로에서 `students`를 `studentCategory`로 재원생·비원생으로 가른 뒤, 비원생 섹션은 `[목록 내 비원생, ...pastResults]`를 합쳐 `Set`으로 id 중복을 제거한 단일 배열로 만들었다. 목록 내 비원생(상담 등)을 앞에 두어 우선 보존하고, 검색 전용 pastResults(퇴원/종강) 중 이미 목록에 있는 항목은 dedup으로 걸러진다. 합친 배열을 기존 `renderPastStudentResults`(헤더 "비원생")에 그대로 넘겨 단일 섹션으로 렌더하므로, 재원생이 0명이어도 비원생 섹션은 독립적으로 노출된다.

## 미해결/메모
- `STUDENT_STATUS_GROUPS`는 스펙 지시대로 import했으나 현재 코드 미사용(SSoT 일관성 목적). 빌드 영향 없음. 지속 미사용 시 정리 후보.
- simplify(헬퍼 통합) → review(추가 수정 없음) 순차 적용 완료.
