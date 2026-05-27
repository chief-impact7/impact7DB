# DB 구현 스펙 — 학생 표시 통일 (Phase: DB)

상위 이니셔티브: `.memory/project_student_display_unification.md`
공유 모듈 v1.4.0 (`@impact7/shared/enrollment-status`)는 설치 완료. DB 폼 전이(selectableStatuses)는 커밋 004c535로 적용됨. **이번 작업은 DB의 배지·2계층·색상 3건.**

## 사용할 공유 API (이미 설치됨)
app.js:8의 import에 추가: `studentCategory, STATUS_TONE, STUDENT_STATUS_GROUPS`
- `STATUS_TONE`: { 재원:'active', 등원예정:'scheduled', 실휴원:'paused', 가휴원:'paused', 상담:'consult', 퇴원:'ended-hard', 종강:'ended-soft' }
- `studentCategory(status)` → '재원생'(재원/등원예정/실휴원/가휴원) | '비원생'(상담/퇴원/종강)
- `STUDENT_STATUS_GROUPS` (순서 보장): [{category:'재원생',statuses:[등원예정,재원,실휴원,가휴원]},{category:'비원생',statuses:[상담,퇴원,종강]}]

## 항목 1 — 헤더 배지 (status + tone)
status 배지를 STATUS_TONE 기반 클래스(`tone-<tone>`)로 통일.
1. **목록 아이템** (app.js:1357-1360): 하드코딩 statusClass 삼항을 `const statusClass = STATUS_TONE[status] ? 'tone-' + STATUS_TONE[status] : '';` 로 교체.
2. **상세 패널 헤더** `profile-status` (app.js:1724, #detail-header 이름 옆): 현재 plain textContent → tone 배지로. className에 `item-status tone-<tone>` 부여(span 마크업이 없으면 index.html에서 배지 span으로 전환).
3. **상세 수업정보 카드** `detail-status` (app.js:1738): 동일하게 tone 배지 적용.
4. **비원생 목록 아이템** (renderPastStudentItem, app.js:1438): 현재 하드코딩 `"비원생" + st-contact`. → 학생의 **실제 status(상담/퇴원/종강)** 를 tone 배지로 표시(섹션 헤더가 이미 "비원생"이므로 항목엔 실상태 노출이 일관적).

## 항목 2 — 목록 2계층 (재원생 / 비원생)
`renderStudentList` (app.js:1278) 기본 분기(grouped 아님 + expected 필터 아님, 즉 1305줄 경로):
- `students`를 `studentCategory(s.status)`로 재원생/비원생 분리.
- 두 섹션을 `group-header`("재원생" / "비원생" + 카운트)로 렌더, 항목은 renderStudentItem.
- **상담이 비원생 섹션에 노출됨**(기존엔 메인 목록에 섞임).
- 검색 결과 `pastResults`(현 퇴원/종강 search-only)와 **중복 제거**: 비원생 섹션을 (students 내 비원생 + pastResults) 합쳐 id 기준 dedup 후 단일 섹션으로. 재원생 0명이어도 비원생 섹션은 노출.
- grouped 뷰(groupViewMode≠'none')와 expected-filter 뷰는 현행 유지(자체 그룹핑 존재).

## 항목 3 — 색상 통일 (style.css ~2099-2130)
tone 클래스 6종 정의(목록 배지·상세 배지 공용). **이 hex는 DSC도 동일하게 미러할 SSoT이므로 정확히 지킬 것:**
```
.tone-active     { background: var(--sbux-light); color: var(--sbux-green); }
.tone-scheduled  { background: var(--sbux-light); color: var(--sbux-accent); }
.tone-paused     { background: #fef7e0; color: #b06000; }
.tone-consult    { background: #ede7f6; color: #5e35b1; }   /* 신규: 상담=보라 */
.tone-ended-hard { background: #fce8e6; color: #c5221f; }
.tone-ended-soft { background: #eceff1; color: #546e7a; }   /* 신규: 종강=슬레이트 */
```
- `.item-status` 베이스 클래스는 유지.
- 마이그레이션 후 미사용이 된 `.st-active/.st-scheduled/.st-paused/.st-withdrawn/.st-contact`는 **삭제**(AGENTS.md: 하위호환 잔재 금지). 단 다른 곳에서 참조하면 그곳도 tone으로 전환.

## 제약
- 모듈 분리: 위 항목은 기존 render 함수 인라인 수정이라 별도 모듈 추출 강제하지 않음. import만 app.js:8 기존 줄에 추가.
- 빌드: `npx vite build` 성공 확인.
- 커밋/푸시는 하지 말 것 — 사용자가 실화면 확인 후 결정.
