---
name: app.js 점진적 모듈 분리 규칙
description: app.js(~6000줄) 단일 파일을 점진적으로 분리하는 규칙과 분석 근거. 새 기능 추가 시, 기존 코드 수정 시 반드시 참조.
type: feedback
---

app.js에 새 코드를 추가하지 말고 별도 모듈로 작성하라. 기존 코드는 수정할 때 분리하라.

**Why:** impact7DB는 에코시스템 4개 앱(DB/DSC/HR/exam)의 마스터 데이터 허브다. students 스키마 변경 등 cross-app 영향이 큰 수정이 app.js에서 발생하는데, 6000줄 단일 파일은 수정 리스크가 높다. 전면 리팩토링은 공유 상태(allStudents 94회, activeFilters 60회, currentStudentId 48회 참조) 의존성 때문에 위험하므로 점진적으로 진행한다.

**How to apply:**
- 새 기능 → 별도 `.js` 파일, 공유 상태는 `store.js`에서 import
- 기존 블록 수정 시 → 해당 블록을 분리하면서 상태 접근도 store.js로 전환
- window.* 함수 등록은 모듈 파일 안에서 수행
- 상태 변경은 `update()`를 통해야 함 — 직접 mutate(push, splice, 재할당) 금지

## 공유 상태 의존성 분석 (2026-04-12 기준)

| 변수 | 참조 횟수 | 성격 |
|------|----------|------|
| allStudents | 94회 | 거의 모든 블록에서 읽기/쓰기(mutate) |
| activeFilters | 60회 | 필터, 렌더링, 내신, 문법특강 |
| currentStudentId | 48회 | 상세패널, 폼, 메모, 휴퇴원 |
| currentUser | 곳곳 | history_logs email |
| leaveRequests | 30+회 | 휴퇴원 블록 직접 배열 조작 |
| semesterSettings | 15+회 | 학기설정, 문법특강 |

## 블록별 독립성 (분리 용이순)

| 블록 | 줄 수 | 분리 난이도 | 공유 상태 의존 |
|------|------|-----------|--------------|
| 패널 리사이저 (4966~4998) | ~35 | 쉬움 | 없음 (IIFE) |
| 일별 통계 (4266~4487) | ~230 | 쉬움 | currentUserRole만 |
| 내신 시간표 (5000~5378) | ~380 | 보통 | allStudents(R), activeFilters, currentSemester |
| 문법 특강 (5379~5928) | ~550 | 보통~어려움 | allStudents(R/W push), semesterSettings(R/W), currentUser |
| 메모 관리 (3445~3680) | ~240 | 보통 | currentStudentId, memoCache, _memoSubcollectionCache |
| 수업 이력 (3704~3773) | ~70 | 보통 | currentStudentId |
| 휴퇴원요청서 (4488~4962) | ~470 | 어려움 | allStudents(mutate), leaveRequests(mutate), currentUser |
| Google Sheets (2790~3440) | ~650 | 어려움 | allStudents(R/W), currentFilteredStudents, currentUser |
| 일괄 처리 (3774~4263) | ~480 | 어려움 | selectedStudentIds, allStudents, bulkMode |

## 핵심 난점

allStudents 배열을 여러 블록이 직접 mutate한다:
- 문법특강: `allStudents.push(...)` (5725줄)
- CSV Import: `allStudents[existIdx] = ...` (3409줄)
- 휴퇴원: `leaveRequests = leaveRequests.filter(...)` (4946줄)

→ 이 패턴을 쓰는 블록은 `store.js`의 `update()`로 전환해야 안전하게 분리 가능. store.js는 2026-04-12 생성 완료.
