# 일괄수정 개선 구현 (반 이동 + 학교이름 변경)

설계: `docs/superpowers/specs/2026-05-31-bulk-edit-classmove-school-design.md`

## 변경 파일·지점
- `index.html`
  - 반 카드 제목 `반 변경`→`반 이동`, 시작일 `date` input(`#bulk-class-startdate`, 선택) 추가.
  - 새 `bulk-edit-section` "학교이름 변경"(icon school): 초/중/고 라디오(`name=bulk-school-level`, 값 `초등|중등|고등`) + `#bulk-school-name` input + 적용/초기화.
- `app.js`
  - `applyBulkClass`(≈4671): 없는 반 가드, 시작일 override, 문구 변경, startdate 초기화.
  - `resetBulkClass`: startdate 초기화 추가.
  - `applyBulkSchool` / `resetBulkSchool` 신규(resetBulkPromotion 뒤).

## 4기능 구현 요약
1. **이름 변경**: 카드 제목·confirm·완료 alert `변경`→`이동`, history after `(일괄변경)`→`(일괄 이동)`.
2. **시작일**: `#bulk-class-startdate` 값 있으면 각 학생 `moveClass`의 `updatedEnrollments`에서 이동된 정규 enrollment(`class_type==='정규' && semester===sem`) 인덱스를 다시 찾아 `start_date` 덮어씀. 비우면 미변경(moveClass 보존). 완료/초기화 시 input clear.
3. **없는 반 가드**: 반코드 파싱 후 `regularCodes` 집합 생성 → `raw` 미포함 시 alert 후 return.
4. **학교이름 변경**: `applyBulkSchool` — 과거학기·0명·라디오 미선택·빈학교명 가드 → `normalizeSchoolName(raw, level, collectKnownSchoolNames(allStudents))` → confirm → 200건 batch `{[SCHOOL_FIELD[level]]: name}` + history UPDATE(before/after string) → 로컬 `s[field]=name`·`school_level_grade=studentFullLabel(s)`(학부필드 있을 때만) 갱신. level/grade 미변경. import는 기존 재사용.

## 없는반 집합 판정 방식
`allStudents` 순회 → `ENROLLABLE_STATUSES.has(s.status)`(활성) 학생의 enrollments 중 `(e.class_type||'정규')==='정규' && e.semester===sem` 인 것의 `enrollmentCode(e)`(level_symbol+class_number, 빈값 제외)를 Set에 수집. 입력 `raw`(대문자)와 직접 비교. moveClass의 정규 판정(`(class_type||'정규')==='정규'`)·학기 일치와 동일 기준이라 "이동 대상이 실제 존재하는 반"과 일관.

## 빌드 결과
`npx vite build` 통과(36 modules, dist 생성). 경고는 기존 help-guide.js·청크 크기뿐, 본 변경 무관.

## 시나리오 검증(논리)
- 없는 반: 활성·해당학기 정규반에 없는 코드 입력 → alert 후 return(쓰기 0). 존재 코드 → 통과.
- 시작일 입력: 이동 enrollment start_date만 덮어씀(override·day·semester 보존). 미입력: moveClass 결과 그대로.
- 학교 정규화: saveStudent와 동일 `normalizeSchoolName`·knownSchools → "봉영여중" 등 일관 축약.
- 빈 학교명/라디오 미선택: 각각 alert 후 return(쓰기 0).
- 200건 배치·history_logs 기록·로컬캐시·트리거 라벨 갱신 기존 카드 관례 준수. level/grade 불변.
