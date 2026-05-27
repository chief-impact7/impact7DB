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
- [x] **DB 헤더 배지/2계층/색상** — 커밋 6717ab4 (화면 확인 완료, 미푸시). app.js(statusToneClass/statusBadgeHtml 헬퍼, renderStudentList 2계층, profile/detail-status 배지), index.html, style.css(tone 6종, st-* 삭제)
  - 헤더 배지는 `.tag` 스케일 + tone (목록은 작은 `item-status`). 상담/퇴원/종강은 비원생 섹션 간략 카드(bulk 체크박스 없음)
  - tone hex SSoT: active=sbux-green, scheduled=sbux-accent, paused=#b06000/#fef7e0, consult=#5e35b1/#ede7f6, ended-hard=#c5221f/#fce8e6, ended-soft=#546e7a/#eceff1
- [x] **DSC** — shared v1.4.0 bump 완료. 헤더에 status tone 배지 + 출결 병기 (student-detail.js, daily-ops.css). 화면 확인 완료
  - 비활성(퇴원/휴원/등원예정/상담/종강)은 tone 배지 전담, 기존 tag-status는 보조정보만(퇴원날짜/휴원기간/등원예정일). 재원은 [재원][출결] 병기
  - 폼 전이/목록 2계층 = DSC 해당 화면 없어 N/A (마스터 status 편집·목록은 DB 전담, DSC 목록은 일별 출결)
- 이니셔티브 사실상 완료 (DB+DSC 표시 통일). tone hex DB=DSC 동일

## 곁다리 버그 픽스 (2026-05-27, 같은 세션)
DSC 진단평가 등원 버튼(`cycleTempArrival`) permission-denied. 원인: 진단평가신청서(`diagnostic_application`) 경로로 생성된 temp_attendance 문서가 `source`/`source_application_id`/`student_id` 메타필드 보유(admin SDK 생성이라 rules 우회), 클라이언트 update 시 `hasOnly` 화이트리스트 위반. firestore.rules temp_attendance 화이트리스트에 3필드 추가 + 필드상한 20→25. 4 repo 동기화 + impact7db 배포 완료.
**How to apply:** temp_attendance에 외부(exam/진단평가) 동기화 필드가 더 생기면 화이트리스트 갱신 필요. [[feedback_rules_sync_commit]]

## 주의
- DB 기본 뷰는 "이번 학기 누적 뷰"(2026-05-26 작업) — 2계층 재구성 시 이 뷰와의 상호작용 주의
- [[feedback_enrollment_status_consistency]] — enrollment↔status 정합성 SSoT
- 크로스앱이므로 `impact7-orchestrator` 경유
