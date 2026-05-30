---
name: feedback-field-removal-inapp-paths
description: students 공용 필드 제거 시 영향분석은 본선뿐 아니라 인앱 보조 경로(보조 upsert·import 스크립트·read 표시)까지 전수해야 하고, 배포 전 code review 필수
metadata:
  type: feedback
---

students 공용 필드(예: 구 `school` 미러)를 삭제하고 rules 화이트리스트에서 빼는 작업은, 영향분석이 **메인 경로만 잡으면 인앱 보조 경로에서 깨진다.** 반드시 다음을 전수하고, 배포 전 **code review를 돌려라**(self-검증·교차대조만으로는 부족).

**Why:** 2026-05-30 구 school 미러 제거 때, 영향분석(_workspace/22)이 DB/DSC/exam 본선(saveStudent·트리거·라벨·검색)은 잡았으나 **인앱 보조 경로를 누락** → 미러 삭제+rules 제거를 배포한 뒤 기능이 깨졌다:
- DSC `diagnostic.js` 진단평가 첫데이터입력 upsert가 `school` **client write** → rules `hasOnly`로 **permission-denied 차단**.
- DB `upsert-students.js`(admin SDK)가 bare `school`을 **재기록**(삭제한 미러 부활, rules 우회라 조용히).
- DSC `daily-ops`/`export-report`/`past-history`가 사라진 `s.school`을 **read** → 검색/export/이력 빈 표시.
각 작업의 self-검증·교차대조는 통과했지만 이 누락들을 못 잡았고, **사후 code review(qa-validator + repo별 리뷰)가 critical로 발견**했다. 사용자가 "simplify/review 안 하냐"고 지적한 게 옳았다.

**How to apply:**
- 공용 필드 제거 영향분석 체크리스트: ①메인 CRUD ②**보조 upsert 경로**(diagnostic·temp_attendance·진단신청 등 students를 만드는 모든 흐름, client+admin 둘 다) ③**import/migration 스크립트**(admin은 rules 우회하므로 더 위험 — 미러 재기록 가능) ④**read 표시/검색/export/이력** 전 사이트 ⑤다른 앱 cloudrun(newtest 등 별 GCP 프로젝트 포함).
- grep은 본선 파일만 말고 repo 전체 `\.school\b`를 자체 도메인(`temp_attendance`·`contacts`·`ExamAnalysis`·`ExternalScoreEvent`)과 구분해 훑어라.
- **데이터 삭제+rules 변경처럼 비가역·배포형 작업은 커밋·배포 전에 [[feedback_student_field_rules_sync]] 점검 + code review 필수.** AGENTS.md의 simplify→review를 trivial 판단으로 건너뛰지 말 것.
- admin SDK 경로는 rules를 우회하므로 "rules 통과 = 안전"이 아니다. 삭제한 필드를 admin이 재기록하지 않는지 별도 확인.

관련: [[project_school_by_level]] [[feedback_student_field_rules_sync]] [[feedback_db_dsc_parity]]
