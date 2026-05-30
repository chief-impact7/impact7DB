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
- `studentFullLabel(student)` (**v1.15.0~ 예측 학부 기준**) = `normalizeRealLevelGrade`로 매년 진급 반영한 **예측 학부**(졸업→고등)의 학교 정규화 + 학부글자 + 학년. **예측 학부 학교 미입력이면 학교 없이**(`고1`, `고(졸업+6)`). `currentSchool`(=student.level=최종 기록 학부)은 **미러용으로만** 씀(다녔던 학교). **정규화 규칙(수정은 이 모듈에서만):**
  - 접미사 제거: `(초등학교|중학교|고등학교|학교)$`
  - 약어(긴 것 우선): 사범대부속→사대부, 여자→여, 외국어→외, 부속→부
  - 지역명 prefix 제거 17개(서울·경기·인천·부산·대구·광주·대전·울산·세종·강원·충북·충남·전북·전남·경북·경남·제주). 단 제거 후 빈값이거나 학부글자(초/중/고) 1글자면 원복. 예: 서울목동중→목동중, 서울중→서울중.
  - 학부글자 중복 제거(양명초→양명+초=양명초). **단 예외 14개는 학부글자 유지**: 초 서초·활초·소초·속초·시초·도초·백초·생초·연초 / 중 윤중·안중·영중·운중·아중. (고 예외 없음) 예: 서초→서초초, 윤중→윤중중.
  - 졸업(예측=고 이후): `학교고(졸업+N)`, 고 학교 미입력이면 `고(졸업+N)`.

## 트리거 (`functions-shared` onStudentLabelSync, 배포됨)
- students write 시 currentSchool→`school` 미러 + studentFullLabel→`school_level_grade` 동기화. 변경 시에만 write(무한루프 방지).
- **가드(v1.15.0~): 학부별 필드(elementary/middle/high)가 하나도 없을 때만 skip**(미마이그레이션). 진학/졸업 예측 학생(예측 학부 학교 없어도 학부필드 있음)은 라벨 생성. (구: currentSchool 빈값 skip → 예측 학부 도입으로 완화)
- 경로 무관(편집·학년승급·import·진단평가) 발화.

## 입력 / 학년승급 (impact7DB)
- 폼: 현재 학부 학교 1칸(`school_current`) + 이전 학부 접기(`<details>`). saveStudent가 현재 level 필드 + 미러 저장, **모든 학부 필드에 normalizeSchoolName 적용**.
- `applyBulkPromotion`: 학부 전환 시 새 학부 필드에 학교, **이전 학부 필드 보존**.

## 마이그레이션 (완료)
- Phase 1: 현재 학기 333건만(누적 졸업오판 회피). **Phase 2-B: 예측 학부 기준 전환 후 전체 15,032건 백필**(현재학기 제한 해제, status 무관). single school → 최종 기록 학부 필드, 라벨=예측 학부 기준(누적 데이터도 `고(졸업+N)` 정확).
- 스크립트: `migrate-school-by-level.js` (`npm run migrate:schoollevel[:run]`).

## Phase 2 (TODO)
- ✅ **퇴원생 grade 누적(B) 완료**(2026-05-30, Phase 2-B): studentFullLabel을 예측 학부 기준으로 전환 → 누적 데이터도 `고(졸업+N)` 정확. status는 '퇴원' 유지(졸업 신규 없음). 목적=졸업생 현재상태 예측으로 동생·친척 연관 상담. 상세: predicted-level-label spec/plan.
- ⏳ **전역 전환** = 각 앱 자체 학교 라벨 함수를 `@impact7/shared`(studentFullLabel/currentSchool)로 통일하는 작업(단순 .school 치환 아님). 진입점:
  - DSC: `studentShortLabel`·`school-normalizer.js` (students.school 소비 ~30곳 대부분 경유)
  - exam: `formatSchoolShort`·`schoolSearchTerms` (`src/shared/lib/student-display.ts`). exam `.school` 154곳 중 students 소비 ~29곳이 이 함수 경유, 나머지 ~125곳은 시험분석·외부성적 **자체 도메인이라 대상 아님**
  - **DSC 전환 / exam 전환 = 독립 sub-project**. 각각 자체 함수 의미(예측 vs 다녔던 학교) 정밀 분석 → shared 교체 → 빌드/검증. (전역 전환 완료 후 구 school 제거 가능)
- ⏳ 구 `school` 필드 제거(전역 전환 완료 후) → "완전 대체" 완성.
- ⏳ 학년승급 로컬 캐시(allStudents) 학부별 필드 동기화(현재는 트리거/리로드 의존).

## 문서
- Phase 1 설계/계획: `docs/superpowers/specs/2026-05-30-school-by-level-design.md`, `docs/superpowers/plans/2026-05-30-school-by-level.md`
- Phase 2-B(예측 학부) 설계/계획: `docs/superpowers/specs/2026-05-30-predicted-level-label-design.md`, `docs/superpowers/plans/2026-05-30-predicted-level-label.md`

[[feedback_shared_version_conflict]] [[feedback_db_dsc_parity]] [[project_naesin_free_derivation]]
