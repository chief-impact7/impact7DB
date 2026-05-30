# 36. 학년승급 로컬 캐시(allStudents) 학부별 필드 동기화

## 분석 — 현재 누락 지점

app.js의 `allStudents`는 store.js 경유가 아니라 **모듈 로컬 변수**(`let allStudents = []`, line 119)다. 따라서 승급 경로는 기존대로 로컬 객체를 직접 갱신한다(store.js `update()` 규칙은 신규 모듈 대상 — 이 기존 블록은 범위 밖).

핵심: app.js의 화면 라벨(`abbreviateSchool` line 346, 상세 line 1906, 폼/CSV)은 모두 `currentSchool(s)`·`s.level`·`s.grade`에서 **라이브 계산**한다. `school_level_grade`는 app.js가 렌더에 쓰지 않고, 트리거 `onStudentLabelSync`(=`computeLabelUpdate`→`studentFullLabel`)가 admin으로 쓰는 **denormalized 검색/외부소비(DSC·dashboard)용** 필드다.

두 승급 경로 모두 grade/level/school_* 은 로컬에 반영하지만 `school_level_grade`만 트리거 재조회 전까지 stale:
- `applyBulkPromotion`(line 4892): `Object.assign(s, c.updateData)` → grade/level/새 school_* 반영, school_level_grade 누락.
- `runPromotion`(line 6280, 전체 일괄): school_history/grade/level 반영, school_level_grade 누락.
  - 부가: 전환(`_levelChanged`) 시 새 학부 school_* 를 채우지 않음 — 단 Firestore에도 안 씀 → 로컬·원격 일치(동기화 버그 아님, 입력 UI 부재 이슈로 범위 밖). 이전 학부 필드는 양쪽 모두 보존.

## 수정 내역

1. import 추가: `studentFullLabel`을 `@impact7/shared/student-label`에서(DB는 이미 shared 의존).
2. `applyBulkPromotion` 로컬 동기화: `Object.assign` 직후 `s.school_level_grade = studentFullLabel(s)` 추가.
3. `runPromotion` 로컬 동기화: grade/level 갱신 직후 동일 한 줄 추가.

학부 전환 시 새 school_* 는 `updateData[SCHOOL_FIELD[next]]`로 이미 로컬 반영되고 이전 학부 필드는 미변경(보존). 라벨은 트리거와 **동일한 순수 함수** `studentFullLabel`로 로컬 계산하므로 표시·검색이 즉시 일치.

## store.js 규칙 준수

`allStudents`는 store.js 미경유 로컬 배열이라 기존 `Object.assign` 패턴 유지(과도한 리팩터링 금지 지침). store.js로의 마이그레이션은 별도 분리 작업 영역으로 남김 — 이번은 동기화 누락만 보강.

## 빌드 결과

`npx vite build` ✓ (36 modules, 3.85s). help-guide.js 경고는 기존·무관.

## 승급 시나리오 검증 (shared 함수 직접 실행)

- 일반 승급 중2→중3(봉영여자중학교): `봉영여중3` ✓
- 전환 초6→중1(개봉중 입력): `개봉중1`, 이전 `school_elementary='봉영초'` 보존 ✓
- 멱등: 트리거가 같은 데이터로 재계산 시 동일값 → `computeLabelUpdate`의 `!==` 가드로 no-op ✓
- 전환 중3→고1(새 학교 미입력): `고1` (원격과 동일, 학교 빈값 그대로) ✓
