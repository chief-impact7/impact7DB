---
name: student-display-unification
description: 학생 표시 통일 멀티세션 이니셔티브 진행 상태 — 공유모듈 v1.4.0 기반, DB/DSC UI 적용 진행 중
metadata:
  type: project
---

# 학생 표시 통일 (멀티세션 이니셔티브)

DB·DSC에서 학생 상태(status) 표시를 공유 모듈 기준으로 통일하는 작업.

**Why:** DB·DSC가 status 배지 색상·목록 분류·폼 전이 옵션을 각자 하드코딩해 불일치. `@impact7/shared/enrollment-status`를 SSoT로 삼아 통일.

**How to apply:** 이 작업 재개("이어서") 시 이 메모리 + `_workspace/` 산출물로 상태 복구. 새 세션 핸드오프는 반드시 여기 갱신.

## 기반 (완료) — @impact7/shared v1.4.0
`node_modules/@impact7/shared/enrollment-status.js`에 추가됨 (태그 v1.4.0, 테스트 19개 통과):
- `STUDENT_STATUS_GROUPS` — 2계층 [재원생: 등원예정/재원/실휴원/가휴원] [비원생: 상담/퇴원/종강]
- `studentCategory(status)` → '재원생' | '비원생'
- `STATUS_TONE` — 재원=active, 등원예정=scheduled, 실/가휴원=paused, 상담=consult, 퇴원=ended-hard, 종강=ended-soft
- `selectableStatuses(current, isNew)` — 폼 전이 규칙
- `INITIAL_STATUSES` = ['등원예정','재원']

## 진행 상태
- [x] 공유 모듈 v1.4.0 (Task #6)
- [x] **DB 폼 전이** — `selectableStatuses` 적용 (커밋 004c535, app.js:1847-1852)
- [~] DB 헤더 배지/2계층/색상 — 구현 완료(미커밋), **화면 확인 대기**. 변경: app.js(statusToneClass/statusBadgeHtml 헬퍼 L161, renderStudentList 2계층, profile/detail-status 배지), index.html(profile-status→item-status), style.css(tone 6종, st-* 삭제). 색상: 상담=#5e35b1/#ede7f6, 종강=#546e7a/#eceff1
  - 주의: 상담/퇴원/종강은 비원생 섹션의 renderPastStudentItem(간략 카드, bulk-select 체크박스 없음)로 렌더됨
- 미커밋. 사용자 화면 확인 후 커밋 + DSC 진행
- [ ] DSC 폼 전이 — selectableStatuses (적용 여부 미확인)
- [ ] DSC 헤더 배지 — status + tone + **출결 병기**
- [ ] DSC 목록 2계층
- [ ] DSC 색상 통일

## 주의
- DB 기본 뷰는 "이번 학기 누적 뷰"(2026-05-26 작업) — 2계층 재구성 시 이 뷰와의 상호작용 주의
- [[feedback_enrollment_status_consistency]] — enrollment↔status 정합성 SSoT
- 크로스앱이므로 `impact7-orchestrator` 경유
