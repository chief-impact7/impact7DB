---
name: project-diagnostic-label-filter-fixes
description: 진단평가(temp_attendance·상담 students) 데이터 결손이 유발한 라벨·검색·필터 버그 3종 수정 (shared v1.18.0)
metadata:
  type: project
---

# 진단평가 라벨·검색·필터 버그 3종 (2026-05-31)

김윤슬·조효빈 케이스 조사(systematic-debugging)로 발견. 공통 트리거 = **진단평가 생성 경로(newtest cloudrun·DSC `diagnostic.js`)가 학부필드/`updated_at`/정규화를 안 만들고, 표시·필터 함수가 결손에 비강건(fallback 없음)**.

## 버그1 — 라벨에 지역명 잔존 ("서울염경중1") — 3차 시도로 해결
`normalizeSchoolForLabel`(shared)이 접미어 제거 후 `"서울염경"`의 rest `"염경"`이 학부글자로 안 끝나 지역명 제거 조건(`/[초중고]$/`) 실패 → "서울" 잔존. (진단평가가 풀네임 raw 저장.)
- **v1.18.0(실패)**: 조건을 `rest.length>1`로 완화 → **정식명 학교 과삭제(C1 critical)**. 실데이터 18건(`경기과학고`→`과학고`, `부산국제고`→`국제고`, `…사범대학부설고` 여러 지역 충돌). code review가 발견. **교훈: 지역명이 입력접두(`서울 염경중`)인지 정식명(`경기과학고`)인지 글자만으로 자동 구분 불가.**
- **v1.19.0(롤백)**: 기존 가드 복원(과삭제 방지). 버그1 미해결(`서울염경중1` 수용).
- **v1.20.0(최종, 사용자 규칙)**: **학교유형 예외**(`REGION_KEEP_SUFFIX = 과학·국제·미술·예술·사대부·외·체육`)로 분기. stem(접미어·약어 후)이 이 접미사로 끝나면 지역명 유지(정식명), 아니면 제거(입력접두). → `경기과학고1`·`서울사대부고1`·`경기외고1` 보호 + `서울염경중학교→염경중1`·`부산영도초등학교→영도초6` 해결. 양립.

## 버그2 — 상담생 검색 사각지대
기본 뷰(`applyFilterAndRender`, `!hasNonSemesterFilter()`) 상담/종강 필터가 **`updated_at`만** cutoff 비교 → `updated_at` 없는 진단평가 상담생은 `updatedStr ? : false`로 제외. `searchPastStudents`는 퇴원/종강만 → **어디에도 안 나옴**. (updated_at 있는 상담생은 포함돼 "차이" 발생.)
- **수정**: 필터에 `updated_at || first_registered` 폴백(app.js). + 진단평가 생성에 `updated_at` 추가(버그4).

## 버그3 — temp_attendance 라벨 "초6"
`visit-list-render.js:64` `studentShortLabel(ta)`가 temp_attendance(school 단일, **학부필드 없음**)에 적용 → `studentFullLabel`이 `school_*`만 읽어 빈 학교 → `''+초+6="초6"`. **미러 제거 작업의 부작용**(전엔 `s.school` 읽음).
- **수정(v1.18.0)**: `currentSchool`/`studentFullLabel`에 `school_*[predLevel] || student.school` **단일 폴백**. students는 school 삭제됐으니 무영향, temp_attendance·contacts 자체도메인 school만 읽혀 "신목초6". (temp_attendance rules에 school_* 추가하지 않음 — 자체 도메인.)

## 버그4 — 진단평가 생성 보강 (재발 방지)
- **newtest** `cloudrun` `upsertDscStudentFromTemp` baseFields에 **`updated_at: new Date()`** 추가(patchFirestoreDocument가 `{timestampValue}` 직렬화 line 158 → DB 필터 `toDate()` 호환). 조효빈은 newtest 경로라 이게 핵심.
- **DSC** `diagnostic.js`는 `auditSet`가 이미 `updated_at: serverTimestamp()`를 항상 주입(`_auditFields`)하므로 추가 라인은 중복 → 제거(code review). 학교명은 라벨이 정규화하므로 raw 유지.

## 배포 (버그1은 v1.18→19→20 3차)
shared **v1.20.0**(16a201b, 학교유형 예외) + DB b8df833 + DSC(v1.20 bump) + exam(v1.20 bump) + newtest 00070-2vz. 버그2 DB 78cad87(필터 폴백)·버그3 폴백·버그4 newtest 41cdf96·DSC auditSet정리. 데이터 미수정(개별 정답 유지). **code review가 v1.18.0 C1(정식명 과삭제) 발견 → 롤백 → 사용자 규칙으로 재해결.** 리뷰 `_workspace/51`.

[[project_school_by_level]] [[feedback_field_removal_inapp_paths]] [[project_simyeyul_handoff_fixes]]
