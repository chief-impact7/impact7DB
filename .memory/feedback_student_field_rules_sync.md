---
name: feedback-student-field-rules-sync
description: students에 client write 필드 추가 시 firestore.rules allowed 화이트리스트·withinFieldLimit 동기화 필수
metadata:
  type: feedback
---

students 문서에 **클라이언트가 write하는 새 필드**를 추가하면 반드시 `firestore.rules`의 `hasOnlyAllowedStudentFields()` allowed 배열에 그 필드를 추가하고 `withinFieldLimit` 한도도 점검해야 한다.

**Why:** students create/update rules는 `request.resource.data.keys().hasOnly(allowed)` + `withinFieldLimit(N)` 방식이다. allowed에 없는 필드를 client가 보내면 **조용히 rules-reject**된다. 트리거·마이그레이션(admin SDK)은 rules를 우회하므로 버그가 안 터지고, **오직 폼/클라이언트 저장 경로에서만** 깨진다 → 발견이 늦다.

**실제 사고(2026-05-30):** 학부별 학교(`school_elementary/middle/high`)와 트리거의 `school_level_grade`를 도입(Phase 1)하면서 saveStudent가 이들을 client write했으나 rules allowed에 안 넣어, **학부별 학교 폼 저장이 reject되던 현존 버그**가 배포 상태로 방치됨. git 이력상 rules에 한 번도 없었음. 동종으로 `enrollments_cleared_at/by`(leave-request admin 작성, 264건)도 누락 발견. 수정: allowed에 6필드 추가 + `withinFieldLimit` 30→35(worst 30 + 여유 5). 커밋 DB 4d7d50b.

**How to apply:**
- 학생 필드 추가 PR에는 항상 `firestore.rules` allowed 갱신을 포함.
- allowed 추가 후 `withinFieldLimit(30)` 같은 한도가 빠듯한지 실측(admin으로 실제 문서 worst-case 키 수 확인). 빠듯하면 상향하되 과도하게 올리지 말 것.
- rules 변경은 DB가 SSoT → `firebase deploy --only firestore:rules --project impact7db` 후 [[feedback_rules_sync_commit]] 규율대로 4앱 동기화·커밋.
- 검증: `firebase deploy --only firestore:rules --dry-run`으로 컴파일 확인.

관련: [[project_school_by_level]] [[feedback_rules_sync_commit]] [[feedback_enrollment_status_consistency]]
