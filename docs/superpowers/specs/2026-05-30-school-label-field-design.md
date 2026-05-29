# 학교·학부·학년 라벨(school_level_grade) 정규화 필드 설계

- 날짜: 2026-05-30
- 범위: 크로스앱 (`@impact7/shared` + `functions-shared` 트리거 + impact7DB + 전역 앱 소비)
- 조율: RULES상 크로스앱이므로 impact7DB에서 조율·배포

## 배경 / 문제

학생 표시에 "봉영여중1, 이대부고1, 양명초6" 같은 **학교(정규화) + 학부단축 + 학년** 라벨이 에코시스템 전역(DB/DSC/HR/exam/consultation/newtest/dashboard)에서 광범위하게 쓰인다. 그런데 이 조합을 각 앱·각 파일이 **제각각 그때그때 만든다**:
- DB: `school-normalizer.js:61`(`${school}${levelShort}${grade}`), `app.js:353`, `naesin-schedule.js:32`, `promo-extractor.js:36` 등
- 타 앱들도 자체 조합

게다가 학생 데이터 입력 경로가 분산돼 있다: 개별 편집, 학년 승급 일괄변경, import/upsert, **진단평가 신청** 등. 조합 로직 변경 시 모든 곳을 각기 수정해야 하고, 표시가 앱마다 어긋날 수 있다.

## 목표

라벨을 **단일 소스 함수 + 저장 필드**로 통일하고, **Cloud Function 트리거**로 동기화를 보장해, 전역 앱이 조합 없이 필드만 읽게 한다.

## 비목표 (YAGNI)

- 전역 앱(DSC/HR/exam 등)의 소비 전환을 이번에 전부 완료 — 필드·함수·트리거 **기반 구축**이 1차. 각 앱 조합 로직 제거는 필드가 채워진 뒤 점진 전환(후속).
- school 필드 자체의 원본 정규화 마이그레이션(별도 주제).

## 설계

### 1. 공유 함수 (단일 소스)
- `@impact7/shared`에 `studentFullLabel(student)` 추가 → `정규화학교 + levelShort + grade` = "봉영여중1".
- 현재 DB 로컬 `school-normalizer.js`(`cleanSchoolName`/`levelShortName`/`normalizeSchoolName`/`schoolSearchTerms`)를 shared로 승격(SSoT). DB는 import로 전환.
- **졸업생(고3 이후)**: 기존 `promo-extractor`의 `졸업+N` 표기 유지(예: "이대부고졸업+1"). studentFullLabel이 이 규칙을 포함.
- 학부단축: `초/중/고` (`levelShortName`).

### 2. 저장 필드
- `students.school_level_grade` (문자열) — 값 = `studentFullLabel(student)`.
- 용도: 검색·정렬·그룹핑 + 전역 표시.

### 3. Cloud Function 트리거 (동기화)
- `functions-shared` codebase에 `onDocumentWritten('students/{id}')` 트리거 신설.
- 동작: 변경 후 문서의 `school`/`level`/`grade`로 `studentFullLabel` 합성 → 기존 `school_level_grade`와 다르면 그 필드만 update.
- **무한루프 방지**: 재계산 결과가 기존 값과 같으면 write 스킵. (label만 바뀐 write는 school/level/grade 불변 → 결과 동일 → 스킵)
- **경로 무관 커버**: students 문서가 편집·승급·import·진단평가 등 어떤 경로로 쓰이든 발화 → stale 원천 차단.
- `functions-shared`가 `@impact7/shared`를 의존에 추가해 동일 함수 사용(SSoT).

### 4. 전역 앱 소비
- 각 앱은 `student.school_level_grade` 읽기만 → 제각각 조합 로직 제거(점진).

### 5. 마이그레이션
- 기존 전체 students에 `school_level_grade` 백필 (admin SDK, 200건 청크 배치).
- **대량 배치라 실행 전 사용자 승인 필수** ([대량 배치 사용자 승인](.memory/feedback_no_autonomous_batch.md)).

## 미결 / 위험 (구현 계획 전 검증·결정)

| 항목 | 내용 |
|------|------|
| 진단평가 입력 경로 | `students`에 직접 쓰는지(트리거 즉시 커버) vs 별도 컬렉션→students 승격 시점 커버인지 확인 |
| `normalizeSchoolName`의 `knownSchools` 의존 | unsafe 접미사(예 "초") 제거는 다른 학생 학교명 집합이 필요. 트리거는 단일 문서 컨텍스트라 전체 집합 부재 → safe 접미사만 제거하거나 캐시 전략 결정 |
| 트리거 비용 | students write마다 발화(enrollment 변경 등 포함). 같은 값이면 스킵하므로 실제 write는 school/level/grade 변경 시만. 발화 빈도·비용 점검 |
| 무한루프 | label-only update가 재발화해도 결과 동일→스킵으로 종료 확인 |
| functions-shared 배포 | `firebase deploy --only functions:shared` (leave-request 건드리지 않음, AGENTS 규칙) |

## 테스트 관점
- `studentFullLabel`: 초/중/고 + 학년, 졸업+N, 학교 접미사 정규화, 빈 값 → 순수함수 단위 테스트(@impact7/shared).
- 트리거: school/level/grade 변경 시 갱신, 무관 변경 시 스킵(무한루프 없음).
- 백필 후 표본 검증.
