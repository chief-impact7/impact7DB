# 예측 학부 기준 라벨 (졸업/진학 예측) 설계 — Phase 2-B

- 날짜: 2026-05-30
- 범위: `@impact7/shared` + `functions-shared` 트리거 + impact7DB (백필). 전역 전환·school 제거는 별개 sub-project
- 조율: impact7DB

## 배경 / 문제

학생 데이터의 `grade`는 **입학 학부 기준 현재 학년 + 매년 +1**이고, `level`은 우리가 마지막으로 기록한 학부다. 학년승급이 반영된 학생은 `level`이 실제와 맞지만, **누적 데이터**(학부 전환 없이 grade만 누적된 학생, 예: `level=중등, grade=7`)는 `level`이 실제 현재 학부와 어긋난다.

현재 `studentFullLabel`은 학교를 `student.level`(최종 기록 학부) 기준으로 읽어, 누적 학생이 **"봉영여고(졸업+1)"** 처럼 나온다(봉영여중 다닌 학생인데 학교명이 딸려 나옴). 사용자 모델은 다르다:

- 봉영여중3(중3)이 마지막 기록 → 다음 해는 **고1**(중4❌). 고등학교명을 입력 안 했으면 **학교 비움 → "고1"**(봉영여고1❌)
- 졸업이면 **"고(졸업+6)"** (학교 없이)
- "최종 기록 학부보다 진급한 학부의 학교를 입력하지 않았으면 그 학부 학교는 비어 있다" — **모든 영역에서 동일**

## 목표

라벨/예측이 **현재 예측 학부**(`normalizeRealLevelGrade`로 매년 진급 반영) 기준으로 동작하게 한다. 예측 학부의 학교 필드가 비어 있으면 학교 없이 학부+학년(또는 졸업+N)만 표시. 전체 학생에 적용해 졸업생의 **현재 예측 상태**(졸업+N)를 식별 — 졸업생의 동생·친척 연관 파악(상담 활용).

## 비목표

- status에 '졸업' 신규 도입 — **'퇴원' 유지**(기존 체계 변경 없음)
- 전역 앱 `.school` → `currentSchool` 전환, 구 `school` 제거 — 별개 sub-project
- grade/level 데이터 자체 보정 — 라벨/예측 로직만(데이터는 그대로, 예측은 파생)

## 설계

### 1. `studentFullLabel` 학교 lookup을 예측 학부 기준으로 (shared v1.15.0)
```js
const norm = normalizeRealLevelGrade(student);       // 예측 {level, grade, graduated}
const predLevel = norm.graduated ? '고등' : norm.level;
const school = normalizeSchoolForLabel(student?.[SCHOOL_FIELD[predLevel]] || '');
```
- 예측 학부의 학교 필드가 비어 있으면 `school=''` → 학교 없는 라벨(`고1`, `고(졸업+6)`).
- 정상 데이터(`student.level` = 예측 학부)는 기존과 동일 결과(무영향).
- 졸업 분기는 그대로 `${school}${lv}(졸업+N)` (school 비면 `고(졸업+N)`, lv는 '고').

### 2. `currentSchool`(미러용)은 최종 기록 학부 유지
- `currentSchool(student)` = `student[SCHOOL_FIELD[student.level]]` 그대로 — **미러 `school`은 "우리가 다녔던 마지막 학교"**(봉영여중)를 담아 전역 앱·검색에 쓰임.
- 라벨(예측 상태 "고(졸업+6)")과 미러(다녔던 학교 "봉영여중")는 **의도적으로 다른 값**. 미러=과거 사실, 라벨=현재 예측.

### 3. 트리거 가드 조정 (`functions-shared`)
- 기존: `currentSchool` 빈값이면 skip → 진학/졸업 학생(예측 학부 학교 없음)도 막혀 "고(졸업+6)" 라벨이 안 생김.
- 변경: **학부별 필드(elementary/middle/high)가 하나도 없을 때만 skip**(진짜 미마이그레이션). 하나라도 있으면 라벨/미러 동기화 진행.
```js
export function computeLabelUpdate(data) {
  const hasAnySchool = !!(data?.school_elementary || data?.school_middle || data?.school_high);
  if (!hasAnySchool) return null; // 미마이그레이션만 skip
  const update = {};
  const mirror = currentSchool(data);
  if (data?.school !== mirror) update.school = mirror;
  const label = studentFullLabel(data);
  if (data?.school_level_grade !== label) update.school_level_grade = label;
  return Object.keys(update).length ? update : null;
}
```
> 미러 `school`은 currentSchool(최종 기록 학부)이라 빈값일 수도(해당 학부 미입력) — 그 경우 `school: ''`로 갱신될 수 있으나, 다른 학부 필드가 있으면 진행.

### 4. 전체 백필 (현재 학기 제한 해제)
- Phase 1 백필은 현재 학기(2026-Spring 등) 학생만이었다(졸업오판 회피용). 예측 학부 기준이 되면 누적 학생도 "고(졸업+N)"으로 정확하므로 **전체 학생** 백필 가능.
- single `school` → **최종 기록 학부 필드**(`SCHOOL_FIELD[student.level]`)에 백필(없을 때만). 라벨/미러는 위 로직으로 동기화.
- admin batch 200청크, dry-run → 사용자 승인. [[feedback_no_autonomous_batch]]

## 검증 시나리오 (단위 테스트)
- 봉영여중3 (중등/3, school_middle=봉영여중) → `봉영여중3` (정상, 무영향)
- 누적 중등/7 (school_middle=봉영여, school_high 없음) → `고(졸업+1)` (예측 졸업, 고 학교 미입력)
- 중등/4 (school_high 없음) → `고1` (중4❌, 진학 예측 + 고 미입력)
- 중등/4 + school_high=대일 → `대일고1` (고 학교 입력시)
- 고등/2 (school_high=신서) → `신서고2` (정상)
- 트리거: 학부별 필드 전무 → skip / 하나라도 있으면 라벨 생성(학교 없어도 "고1")

## 위험
| 위험 | 완화 |
|------|------|
| 미러(과거 학교) vs 라벨(예측) 다름 → 혼란 | 의도 문서화. 미러=다녔던 학교, 라벨=예측 상태 |
| 정상 데이터 라벨 변동 | student.level=예측 학부면 무영향 — 테스트로 보장 |
| 전체 백필 대량(15,674) | dry-run + 사용자 승인, 200청크 |
| shared v1.15.0 선점 | 시작 전 확인 [[feedback_shared_version_conflict]] |
