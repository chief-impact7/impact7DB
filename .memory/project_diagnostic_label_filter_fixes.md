---
name: project-diagnostic-label-filter-fixes
description: 진단평가(temp_attendance·상담 students) 데이터 결손이 유발한 라벨·검색·필터 버그 3종 수정 (shared v1.18.0)
metadata:
  type: project
---

# 진단평가 라벨·검색·필터 버그 3종 (2026-05-31)

김윤슬·조효빈 케이스 조사(systematic-debugging)로 발견. 공통 트리거 = **진단평가 생성 경로(newtest cloudrun·DSC `diagnostic.js`)가 학부필드/`updated_at`/정규화를 안 만들고, 표시·필터 함수가 결손에 비강건(fallback 없음)**.

## 버그1 — 라벨에 지역명 잔존 ("서울염경중1")
`normalizeSchoolForLabel`(shared)이 **접미어("중학교")를 먼저 제거**하면 `"서울염경"`의 rest `"염경"`이 학부글자로 안 끝나 지역명 제거 조건(`/[초중고]$/`)이 실패 → "서울" 잔존. (축약형 `서울염경중`만 가정한 조건. 풀네임은 진단평가가 raw 저장해서 발생.)
- **수정(v1.18.0)**: 조건을 `rest.length>1`로(풀네임도 제거). **단 약어(SCHOOL_ABBR=사범대부속·외국어 등)가 적용된 학교는 '서울'이 학교명 일부('서울대 사대부')일 수 있어 지역명 제거 건너뜀**(`if (s===beforeAbbr)`). → `서울염경중학교→염경중1`, `서울사범대부속고→서울사대부고1` 둘 다 정확.

## 버그2 — 상담생 검색 사각지대
기본 뷰(`applyFilterAndRender`, `!hasNonSemesterFilter()`) 상담/종강 필터가 **`updated_at`만** cutoff 비교 → `updated_at` 없는 진단평가 상담생은 `updatedStr ? : false`로 제외. `searchPastStudents`는 퇴원/종강만 → **어디에도 안 나옴**. (updated_at 있는 상담생은 포함돼 "차이" 발생.)
- **수정**: 필터에 `updated_at || first_registered` 폴백(app.js). + 진단평가 생성에 `updated_at` 추가(버그4).

## 버그3 — temp_attendance 라벨 "초6"
`visit-list-render.js:64` `studentShortLabel(ta)`가 temp_attendance(school 단일, **학부필드 없음**)에 적용 → `studentFullLabel`이 `school_*`만 읽어 빈 학교 → `''+초+6="초6"`. **미러 제거 작업의 부작용**(전엔 `s.school` 읽음).
- **수정(v1.18.0)**: `currentSchool`/`studentFullLabel`에 `school_*[predLevel] || student.school` **단일 폴백**. students는 school 삭제됐으니 무영향, temp_attendance·contacts 자체도메인 school만 읽혀 "신목초6". (temp_attendance rules에 school_* 추가하지 않음 — 자체 도메인.)

## 버그4 — 진단평가 생성 보강 (재발 방지)
- newtest `cloudrun` `upsertDscStudentFromTemp` + DSC `diagnostic.js` `_upsertStudentFromTemp` baseFields에 **`updated_at`** 추가. (newtest는 `new Date()`→patchFirestoreDocument가 `{timestampValue}` 직렬화 line 158; DSC는 `serverTimestamp()`.) 학교명 정규화는 라벨(v1.18.0)이 처리하므로 raw 유지.

## 배포
shared v1.18.0(29dff6b) + DB 78cad87 + DSC 7260415 + exam 6835469(bump) + newtest 00070-2vz. 데이터 미수정(개별 정답 유지). 테스트 shared 88 pass.

[[project_school_by_level]] [[feedback_field_removal_inapp_paths]] [[project_simyeyul_handoff_fixes]]
