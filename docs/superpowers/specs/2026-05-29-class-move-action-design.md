# 반 이동 안전화 설계 — 학기 컨텍스트 가드 중심 보강

- 날짜: 2026-05-29
- 대상 앱: impact7DB, impact7newDSC (공유 Firestore `students` / `@impact7/shared`)
- 접근: **전용 액션 신설이 아니라, 기존 반 변경 경로를 학기 컨텍스트 가드로 안전화 + 공유화** (보강 중심)
- 상태: 설계 승인 대기

## 1. 배경 / 문제

학생의 정규반(`enrollment.class_number`)을 옮기는 경로가 내신·휴원 엣지케이스에서 깨진다.

촉발 사건: 정규 휴원 중 정규반이 HX106이던 학생이 내신으로 복귀했고, 그 사이 HX106이 HX108로 합반(merge)됐는데 이 학생만 HX108로 옮겨지지 못했다.

근본 원인:
- 내신 활성 기간엔 `applyNaesinFreeDerivation`(`node_modules/@impact7/shared/enrollment-derivation.js:17`, DB `app.js:308`)이 정규 enrollment를 숨기고 합성 "내신"으로 치환한다. 정규(HX106)는 raw `enrollments`에 살아 있지만 가려진다.
- 그 결과 내신 학생은 반 그룹에서 "미지정"으로 빠져, 합반(일괄 반 변경)을 HX106 그룹으로 선택할 때 누락된다.

## 2. 핵심 발견 (코드 검증)

`relevantEnrollments`(`app.js:321`)가 학기 필터 상태로 갈린다:
```
학기 OFF → getActiveEnrollments(s)          // 내신 파생, 정규 숨김
학기 ON  → enrollments.filter(semester===) // raw 학기 enrollment, 정규 살아있음
```
- 반 태그(`app.js:1495`)·반별 그룹핑(`app.js:1620-1621`)·반 필터(`app.js:1176`)가 모두 `activeClassCodes`(→`relevantEnrollments`)를 사용.
- 일괄 반 변경 `applyBulkClass`(`app.js:4589`)는 학기 ON이면 `findIndex(e => e.semester === sem)`(`app.js:4611`)로 그 학기 정규를 정확히 집어 in-place 교체.

**결론: 학기 필터를 켜면 내신 학생이 HX106 그룹에 다시 나타나고(합반 누락 해소) + 정규를 정확히 타겟팅한다(내신 숨김 해소). 두 문제가 학기 ON 하나로 동시에 풀린다.**

전제: 그 정규 enrollment에 `semester` 값이 있어야 학기 필터로 잡힌다. 없으면 누락되므로 보고 필요.

## 3. 기존 경로가 이미 충족하는 것 (`applyBulkClass`)

| 항목 | 상태 |
|------|:----:|
| 내신 숨김 학생도 대상(raw `enrollments` 직접 조작) | ✅ |
| in-place 교체, `start_date`·`day`·`override`·`semester` 보존 | ✅ |
| branch 재파생(`branchFromClassNumber`) | ✅ |
| history_logs 기록, 200건 청크 배치 | ✅ |

→ 신설하지 않고 이 경로를 보강한다.

## 4. 목표 / 비목표

목표:
- 반 이동(개별·다수)이 내신 숨김·휴원과 무관하게 안전하게 동작.
- 합반 시 내신 학생 누락 방지.
- 막연한 학기 컨텍스트(어느 학기인지 불확실)에서의 실행 차단.
- DB·DSC 동일 로직 공유.

비목표:
- 새 반 생성·신규 배정(반생성마법사 역할).
- 전용 "반 이동" UI 신설(이번엔 하지 않음).
- 학생상세 단건 전용 진입 버튼(단건 이동은 벌크 모드 1명 선택으로 처리).
- 특강·자유학기 enrollment 이동(1차 범위는 정규).

## 5. 변경 사항

### 5.1 학기 컨텍스트 가드 (핵심 / 필수)
- 반 변경 실행 시 학기 컨텍스트가 OFF면 **차단하고 학기 선택을 유도**한다.
  - DB 일괄 반 변경 `applyBulkClass`: 현재 학기 OFF면 무조건 `enrollments[0]`을 건드림(`app.js:4612`) → 이 폴백을 제거하고, 학기 미선택이면 "어느 학기 수업을 옮길지 먼저 학기를 선택하세요" 안내 후 중단.
  - DB 개별 편집의 반번호 변경 경로: 학기 OFF에서 내신 학생 편집 시 정규가 숨겨지고 저장 병합에서 소실 위험(`app.js:2109`, `2229`) → 동일 가드 또는 raw 학기 enrollment 편집으로 유도.

### 5.2 누락 보고 (필수)
- 학기 컨텍스트로 대상 정규 enrollment를 못 찾은 학생(`semester` 미기재 등)은 조용히 skip하지 않고(현재 `app.js:4613` return) **명단으로 보고**한다. → 데이터 정리 대상 노출.

### 5.3 override A/B 정합성 경고 (권장)
- 반번호 끝자리(A/B) 기반 내신 csKey가 이동으로 달라지면 "내신 매핑이 바뀔 수 있음" 경고. (DSC 조사에서 식별된 위험)

### 5.4 충돌 검사 (권장)
- 이동 결과가 같은 학기에 동일 반명을 만들면 `findEnrollmentConflicts`(`app.js:2237`) 재사용으로 차단. ([동일 시기 동일 반명 금지](.memory/project_unique_class_code.md))

### 5.5 공유화 (필수, 파리티)
- 반 이동 핵심 로직을 `@impact7/shared`의 순수 함수(가칭 `moveClass(student, { semester, targetLevelSymbol, targetClassNumber, today }) → { updatedEnrollments, before, after, warning, skipped }`)로 추출.
- DB `applyBulkClass`가 이 함수를 호출하도록 전환. DSC에도 동일 가드·로직 적용(현재 DSC 학생상세는 내신 숨김 학생 edit 버튼 미표시 `student-detail.js:1140` → 보강 또는 동일 일괄 경로 제공). ([DB↔DSC 항상 동일](.memory/feedback_db_dsc_parity) 준수)
- 쓰기·history_logs·로컬 동기화는 각 앱 호출부 책임(함수는 순수).

## 6. 동작 흐름 (다수/합반 기준)

1. 좌측 Semester에서 대상 학부 학기를 **ON**(예: 고 2026-Spring).
2. 내신 학생 포함 HX106 그룹이 목록에 복원됨 → 벌크 모드로 전원 선택.
3. "일괄 반 변경"에 `HX108` 입력.
4. `moveClass`가 각 학생의 해당 학기 정규를 in-place로 HX108로 교체(override/이력 보존).
5. 대상 못 찾은 학생은 명단 보고, 충돌·override 변동은 경고.
6. 200건 청크 배치 쓰기 + history_logs.

## 7. 위험 / 완화

| 위험 | 완화 |
|------|------|
| `semester` 미기재로 누락 | 5.2 누락 보고 |
| 학기 OFF 무방비 변경 | 5.1 가드 |
| 내신 override A/B 매핑 변동 | 5.3 경고 |
| 동일 시기 동일 반명 | 5.4 충돌 검사 |
| DB·DSC 동작 분기 | 5.5 공유 함수 |
| 대량 배치 사고 | [대량 배치 사용자 승인](.memory/feedback_no_autonomous_batch.md), 200건 청크 |

## 8. 테스트 관점

- 내신 활성 학생: 학기 ON 후 반 이동 → 정규 class_number만 변경, override·내신 파생 유지.
- 휴원 학생: status 불변, 정규만 이동.
- 합반: 학기 ON에서 HX106 다수(내신 학생 포함) 선택 → HX108 일괄, 누락 0.
- `semester` 미기재 학생: skip되고 명단 보고.
- 학기 OFF 실행: 차단되고 학기 선택 유도.
- DB·DSC 동일 입력 → `moveClass` 동일 출력(파리티).
