---
name: school-by-level
description: 학부별 학교명(school_elementary/middle/high) + school_level_grade 라벨 도입. studentFullLabel 정규화 규칙(약어·지역명·예외) SSoT
metadata:
  type: project
---

# 학부별 학교명 + school_level_grade 라벨 (2026-05-30 Phase 1 배포)

## 데이터 모델
- 학교명 = **학부별 3필드** `school_elementary` / `school_middle` / `school_high` (빈값=모름). 진학(초6→중1)해도 이전 학부 학교 보존.
- 단일 `school`은 **현재 학부 미러**(Phase 1 호환 — 전역 앱 DSC/exam이 아직 읽음). Phase 2에서 제거 예정.
- `school_level_grade` = "봉영여중1" 라벨(검색·정렬·표시용).

## 공유 로직 (`@impact7/shared/student-label`, v1.14.0)
- `currentSchool(student)` = `student[SCHOOL_FIELD[level]]`. `SCHOOL_FIELD = {초등:school_elementary, 중등:school_middle, 고등:school_high}`.
- `studentFullLabel(student)` = 현재 학부 학교 정규화 + 학부글자 + 학년. **정규화 규칙(수정은 이 모듈에서만):**
  - 접미사 제거: `(초등학교|중학교|고등학교|학교)$`
  - 약어(긴 것 우선): 사범대부속→사대부, 여자→여, 외국어→외, 부속→부
  - 지역명 prefix 제거 17개(서울·경기·인천·부산·대구·광주·대전·울산·세종·강원·충북·충남·전북·전남·경북·경남·제주). 단 제거 후 빈값이거나 학부글자(초/중/고) 1글자면 원복. 예: 서울목동중→목동중, 서울중→서울중.
  - 학부글자 중복 제거(양명초→양명+초=양명초). **단 예외 14개는 학부글자 유지**: 초 서초·활초·소초·속초·시초·도초·백초·생초·연초 / 중 윤중·안중·영중·운중·아중. (고 예외 없음) 예: 서초→서초초, 윤중→윤중중.
  - 졸업(고3 초과 누적학년): `학교고(졸업+N)`.

## 트리거 (`functions-shared` onStudentLabelSync, 배포됨)
- students write 시 currentSchool→`school` 미러 + studentFullLabel→`school_level_grade` 동기화. 변경 시에만 write(무한루프 방지).
- **가드: currentSchool 빈값이면 skip** — 미마이그레이션/미입력 학생의 school_level_grade 파괴 방지. 이 가드 덕에 마이그레이션 안 된 학생은 트리거가 안 건드림.
- 경로 무관(편집·학년승급·import·진단평가) 발화.

## 입력 / 학년승급 (impact7DB)
- 폼: 현재 학부 학교 1칸(`school_current`) + 이전 학부 접기(`<details>`). saveStudent가 현재 level 필드 + 미러 저장, **모든 학부 필드에 normalizeSchoolName 적용**.
- `applyBulkPromotion`: 학부 전환 시 새 학부 필드에 학교, **이전 학부 필드 보존**.

## 마이그레이션 (완료)
- **현재 학기(2026-Spring / 2026-Spring1 / 2026-Spring2) enrollment 보유 학생 333건만** 백필(status 무관 — 상담/퇴원/휴원 포함). single school → 학부별 + 라벨 + 미러.
- **비현재학기(역대 누적 ~15,000명) 제외**: grade가 누적값(중1=7 식)이라 졸업 오판(B 문제) 발생 → 제외로 회피. 미러 `school` 유지로 전역 앱 호환.
- 스크립트: `migrate-school-by-level.js` (`npm run migrate:schoollevel[:run]`).

## Phase 2 (미해결 TODO)
- 전역 앱(DSC/exam 등) `.school` 읽기 → `currentSchool`/학부별로 전환.
- 구 `school` 필드 제거(전역 전환 완료 후) → "완전 대체" 완성.
- **퇴원생 grade 누적(B)** 정리 — 졸업 오판의 근본. 정리 후 비현재학기 학생도 라벨 가능.
- 학년승급 로컬 캐시(allStudents) 학부별 필드 동기화(현재는 트리거/리로드 의존).

## 문서
- 설계: `docs/superpowers/specs/2026-05-30-school-by-level-design.md`
- 계획: `docs/superpowers/plans/2026-05-30-school-by-level.md`

[[feedback_shared_version_conflict]] [[feedback_db_dsc_parity]] [[project_naesin_free_derivation]]
