# 학부별 학교명(school_elementary/middle/high) 설계 — Phase 1

- 날짜: 2026-05-30
- 범위: 크로스앱 (`@impact7/shared` + `functions-shared` 트리거 + impact7DB). 전역 앱 전환은 후속(Phase 2)
- 조율: RULES상 크로스앱이므로 impact7DB에서 조율·배포

## 배경 / 문제

학생의 `school`은 단일 필드라, **진학(초6→중1, 중3→고1)으로 학부가 바뀌면 학교명을 새로 입력하지 않는 한 비거나 이전 학부 학교가 그대로 남는다.** 학부별로 다닌 학교가 다른데 한 칸에 덮어쓰는 구조라 이력이 보존되지 않고, "봉영여중1" 같은 라벨도 현재 학부의 학교명을 안정적으로 못 잡는다.

`school`은 에코시스템 전역(DB·DSC·exam 등)에서 읽히므로, 한 번에 바꾸면 옛 코드가 깨진다.

## 목표

학부별 학교명을 별도 필드로 보존하고(다닌 학부는 입력, 모르는 학부는 빈값), 라벨·표시가 현재 학부의 학교명을 정확히 쓰게 한다. **최종적으로 단일 `school`을 학부별 필드로 완전 대체**하되, 안전을 위해 단계적으로 전환한다.

## 비목표 (Phase 1 범위 밖)

- 전역 앱(DSC/exam 등)의 `.school` 소비를 `currentSchool`로 전환 — **Phase 2(후속)**
- 구 `school` 필드 제거 — Phase 2 (전역 전환 완료 후)
- 퇴원생 `grade` 누적값으로 인한 졸업 오판(별개 문제 B) — 이 작업과 무관, 라벨 백필 시 별도 처리

## 설계

### 1. 데이터 모델
- `school_elementary`, `school_middle`, `school_high` (문자열, 빈값=모름)
- 매핑: `SCHOOL_FIELD = { '초등': 'school_elementary', '중등': 'school_middle', '고등': 'school_high' }`

### 2. 현재 학교명 파생 (단일 소스)
- `@impact7/shared`에 추가:
  - `SCHOOL_FIELD` 매핑
  - `currentSchool(student)` → `student[SCHOOL_FIELD[student.level]] || ''`
- `studentFullLabel(student)`이 `student.school` 대신 `currentSchool(student)`을 쓰도록 변경 (shared **v1.14.0**). 배포된 트리거가 자동 연동됨.

### 3. 구 `school` = 현재 학부 미러 (Phase 1 호환 레이어)
- `school` 필드를 제거하지 않고 **항상 `currentSchool` 값으로 동기화**한다.
- 전역 앱(DSC/exam)은 계속 `school`을 읽으므로 무영향.
- Phase 2에서 전역 앱을 `currentSchool`로 전환한 뒤 `school` 제거 → 완전 대체 완성.

### 4. 트리거 확장 (`onStudentLabelSync`)
- 기존 트리거가 `school_level_grade`만 동기화 → **`school`(미러) + `school_level_grade` 둘 다** 동기화하도록 확장.
- 동작: 변경 후 문서로 `currentSchool` 계산 → `school`과 다르면 갱신, `studentFullLabel` 계산 → `school_level_grade`와 다르면 갱신. 둘 다 같으면 write 스킵(무한루프 방지).
- 어떤 경로(편집·승급·import·진단평가)로 students가 쓰이든 미러·라벨이 자동 정합.

### 5. DB 입력 UI
- 신규등록·편집 폼: **현재 학부 학교명 1칸**(기존과 유사) + "이전 학부 학교" 접기(펼치면 다른 학부 칸 입력).
- `saveStudent`: 입력을 해당 학부 필드(`school_elementary` 등)에 저장. `school`은 트리거가 미러하므로 폼에서 직접 안 써도 됨(또는 저장 시 currentSchool도 함께 기록).

### 6. 학년 승급 연동
- 학부 전환(초6→중1) 시 새 학부 필드(`school_middle`)가 비어 있으면 입력 유도(빈값 허용). **이전 학부 필드(`school_elementary`)는 보존**.
- 일괄 학년 승격(app.js:4776)의 school 비우기 로직을 학부별 필드 기준으로 조정.

### 7. 마이그레이션
- 기존 전체 students: single `school` → 현재 학부 필드로 복사(`level='중등'`이면 `school_middle = school`). `school`은 미러로 유지.
- admin batch(200청크), dry-run → **사용자 승인 후 실행**. [[feedback_no_autonomous_batch]]

### 8. 진행 중 라벨 작업과의 통합
- `school_level_grade` 트리거·함수는 이 설계로 흡수(currentSchool 기반 v1.14.0).
- **보류했던 라벨 백필(Task 4)은 이 마이그레이션 이후 currentSchool 기반으로 함께 실행**.

### 9. 학교명 정규화 규칙 (`studentFullLabel` / `@impact7/shared`)
`currentSchool`로 얻은 학교명을 라벨용으로 정규화하는 순서:
1. **접미사 제거**: `(초등학교|중학교|고등학교|학교)$`
2. **약어 치환**(긴 것 우선): 사범대부속→사대부, 여자→여, 외국어→외, 부속→부
3. **지역명 prefix 제거**: 광역시/도 17개(서울·경기·인천·부산·대구·광주·대전·울산·세종·강원·충북·충남·전북·전남·경북·경남·제주). 단 제거 후 남는 게 **빈값이거나 학부글자(초/중/고) 한 글자뿐이면 원복**. 예: `서울목동중→목동중`, `서울중→서울중`
4. **학부글자(levelShort) 결합 + 중복 제거**: 학교명이 학부글자로 끝나면 생략(예: `양명초`→`양명`+초=`양명초`). 단 **예외 14개는 유지** — 초: 서초·활초·소초·속초·시초·도초·백초·생초·연초 / 중: 윤중·안중·영중·운중·아중. (고는 예외 없음). 예: `서초`+초=`서초초`, `윤중`+중=`윤중중`

> 이 규칙은 studentFullLabel v1.14.0에 currentSchool 전환과 함께 포함. 기존 단위 테스트(봉영여중1 등)에 위 케이스(서초초·윤중중·서울목동중·서울중) 추가.

## 미결 / 위험 (구현 계획 전 검증)

| 항목 | 내용 |
|------|------|
| 퇴원생 grade 누적(B) | 학부별 학교명과 별개. 라벨 백필 시 퇴원생 졸업 오판 잔존 → 백필을 활성 재원생만으로 제한할지 그때 결정 |
| school 읽는 DB 내부 소비처 | app.js 등 DB 내부의 `.school` 읽기(표시·검색)를 `currentSchool`로 전환할지(Phase 1) vs 미러 `school` 그대로 둘지 — Phase 1은 미러 유지로 최소 변경, DB 표시도 점진 |
| 트리거 비용 | school·label 2필드 비교 후 변경 시만 write. 빈도 점검 |
| shared v1.14.0 선점 | 시작 전 shared version·태그 확인 [[feedback_shared_version_conflict]] |

## 테스트 관점
- `currentSchool`: level별 올바른 필드 반환, 빈값/미입력 안전 — 순수 단위 테스트.
- `studentFullLabel`: currentSchool 기반으로 기존 라벨 케이스 유지(봉영여중1 등).
- 트리거: school·label 동기화, 둘 다 같으면 스킵(무한루프 없음).
- 마이그레이션 dry-run 표본 검증.
