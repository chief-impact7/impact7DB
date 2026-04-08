---
name: 동일 시기 동일 반명 금지 규칙
description: 한 학생의 enrollments에서 같은 level_symbol+class_number를 가진 반은 시기가 겹치면 안 됨 (정규/특강/내신 무관)
type: project
---

한 학생의 `enrollments` 배열에서 동일한 `level_symbol+class_number` 코드(예: `EX102`)를 가진 enrollment는 **시기(start_date~end_date 기간)가 겹치면 안 된다**. 시기가 겹치지 않으면 OK.

**Why:** 정규반과 특강반의 이름이 같으면 절대 안 됨 (학원 운영 규칙). 2026-04-08 작업 일지 — 411명 활성 학생 중 11명이 정규+특강이 동일 코드(EX102 등)를 공유한 채로 등록되어 있었음. 모두 입력자의 인지 부족에 의한 데이터 입력 실수. 11건 모두 특강 enrollment를 삭제하여 정리. (스크립트: `_fix_dup_enrollment_codes.cjs`)

**How to apply:**
- 새 enrollment 추가/수정 시 같은 코드를 가진 다른 enrollment의 시기와 겹치는지 검사한다.
- 시기 겹침 = `[startA, endA] ∩ [startB, endB] !== ∅`. end_date가 비어 있으면 무한대로 간주.
- 겹치면 **무조건 차단** (alert + 저장 거부, confirm 강행 옵션 없음 — 2026-04-08 사용자 지시).
- 검사 진입점: `saveEnrollment` (모달 단건 추가), `submitNewStudent` 신규/수정 모드.
- 헬퍼: `findEnrollmentConflicts`, `blockOnEnrollmentConflicts` (app.js ~line 103).
- enrollment 삭제 후 `enrollmentCode()`(app.js:100) 자체는 변경 안 함 — 사이드바 Class 필터가 코드 기반이라 함수 시그니처를 유지해야 안전.
