# 22. 구 단일 `school` 미러 필드 제거 — 크로스앱 영향 분석

작성: 2026-05-30 · 상태: **분석 전용 (코드·데이터 미수정)** · 범위: 7개 앱 + functions + firestore.rules
근거: `.memory/project_school_by_level.md`, `_workspace/19`·`21`(exam), `_workspace/18`·`20`(DSC)

---

## 0. 핵심 결론 (요약)

1. **표시·검색 라벨은 3앱(DB·DSC·exam) 전환 완료** — display/search는 이미 `currentSchool`/`studentFullLabel`(예측 학부 기준)을 쓴다. 단 **미러 `.school` 잔여 의존이 3종 남아 있어 지금 제거하면 깨진다.**
2. **블로커 3개 (전부 students.school 미러 read·write):**
   - **exam `ExternalScorePanel`** — students `.school`을 `isSameSchoolName`으로 외부성적표 매칭(`studentSchool()`). 표시 아님, **동등성 비교**. → `currentSchool(student)`로 이전 필요.
   - **DSC `DailyLogBoard.buildNaesinKey`** + **DB `naesinHelpers.deriveNaesinCode`/`buildNaesinCsKey`** — 내신 CS키를 `.school`로 생성. **두 앱이 같은 키를 만들어야 매칭**되므로 동시·동일 입력(`currentSchool`)으로 이전해야 함.
   - **newtest cloudrun** — 진단평가 신청서가 students 문서를 `school`(미러)만 써서 생성/patch(`school_*` 미작성). **미러 writer이자 미마이그레이션 doc 생산자.** 전담 에이전트 없음 → 누락 시 신규 상담생 라벨·매칭 깨짐. **최우선 리스크.**
3. **데이터(15,032건)의 `school` 필드는 남겨도 무해**(아무도 안 읽게 만든 뒤). 대량 삭제는 위험 대비 이득 없음 → **dead data로 보존 권고.**
4. **firestore.rules 영향 있음(4앱 동기화).** students 화이트리스트는 `school`을 허용만(필수 아님)하나, **`temp_attendance`(DSC)·`contacts`(DB)는 `school` 비어있지 않음을 강제(require).** 또한 현재 rules 화이트리스트에 `school_elementary/middle/high/school_level_grade`가 **누락**(별도 동기화 필요 — 본 작업의 선결/병행 이슈).
5. **위험도: 높음.** 단순 필드 삭제가 아니라 매칭 로직(내신키·외부성적표) 이전 + 미관리 앱(newtest) 수정 + rules 동기화가 얽힘.

---

## 1. 앱별 students.`school`(미러) 읽기 지점

| 앱 | 파일:라인 | 용도 | 분류 | 전환 난이도 |
|----|----------|------|------|-----------|
| **DB** | `app.js:160`, `2100` | 폼 채우기 (이미 `currentSchool(s)` 사용) | ✅ 이미 전환됨 | — |
| DB | `app.js:345` `abbreviateSchool` | 목록/검색 표시 축약 | 표시 | 낮음 → `currentSchool` |
| DB | `app.js:1818` | 과거학생 폼 자동채움(`pastStudent.school`) | 표시/입력 | 낮음 |
| DB | `app.js:1904` 상세 `detail-school-name` | 상세 표시 | 표시 | 낮음 |
| DB | `app.js:3395`,`3405` 시트 export | Google Sheets 내보내기 학교칸 | 표시(export) | 낮음 → `currentSchool` |
| DB | `app.js:4838` 학년승급 `oldSchool` | 승급 전후 표시 (이미 `SCHOOL_FIELD[oldLevel]||.school` fallback) | 표시 | 낮음(이미 학부필드 우선) |
| DB | `naesin-schedule.js:23`,`67` | 내신 시간표 그룹키·라벨 | **매칭+표시** | 보통 → `currentSchool` |
| DB | `school-normalizer.js:33`,`39`,`55` `collectKnownSchoolNames`/`schoolSearchTerms` | 정규화 known set·검색어 | 파생 | 보통 |
| DB | `past-history.js:314` | 과거이력 카드 표시 | 표시 | 낮음 |
| DB | `promo-extractor.js:317` `buildSchoolGradeStr` | 진급추출 표시 문자열 | 표시 | 낮음 |
| **DB(fn:leave-request)** | `functions/src/naesinHelpers.js:29` `deriveNaesinCode` | **내신 CS코드 생성(매칭키)** | **매칭** | **높음**(DSC와 동시 이전) |
| **DB(fn:shared)** | `functions-shared/src/consultationAiHandler.js:33` | 상담 AI 프롬프트 학교 | 표시(LLM) | 낮음 → `currentSchool` |
| **DSC** | `DailyLogBoard.jsx:60` `buildNaesinKey` | **내신 CS키 생성(매칭키)** | **매칭** | **높음**(DB와 동시 이전) |
| **exam** | `ExternalScorePanel.tsx:45` `studentSchool()` → `241`,`262`,`477` | **외부성적표 `isSameSchoolName` 매칭/저장** | **매칭** | **높음** → `currentSchool` (정규화 비교는 현행 유지) |
| **consultation** | `fetch.js:60` `fetchStudentProfiles`(`...snap.data()`) | 전체 doc spread (school 이름참조 0) | **무영향** | — (school 직접 소비 없음) |
| **DashBoard** | `source.ts:123`,`129` students read | name/grade/branch/status만 매핑, school 미참조 | **무영향** | — |
| **HR** | — | students 컬렉션 자체를 읽지 않음 | **무관** | — |
| **newtest** | (읽기 없음) | — | — | — |

`currentSchool` 정의: `student[SCHOOL_FIELD[level]]`. 미러 `.school`과 현재 학부 학교는 정상 학생에서 동일(미러 = 현재 학부) → 매칭·표시 값 보존됨. 차이는 진급/졸업 시즌 미러 stale 시에만.

---

## 2. students.`school`(미러) 쓰기 경로

| 위치 | 동작 | 제거 시 조치 |
|------|------|------------|
| `functions-shared/src/studentLabelSync.js:10` (`onStudentLabelSync` 트리거) | write마다 `currentSchool→school` 미러 set | **미러 write 라인 삭제** (label write는 유지) |
| DB `app.js:2268` 부근 saveStudent (`...schoolByLevel, school`) | 폼 저장 시 미러 동봉 | `school` 키 제거(3필드만 저장) |
| DB `app.js:4833` `applyBulkPromotion` (`updateData.school = newSchool`) | 학부전환 시 미러 갱신 | 미러 라인 제거(`SCHOOL_FIELD[next]`만) |
| DB `app.js:6217`,`6267` 학년승급 `buildLevelChangeHistory`/로컬 `s.school=''` | 학부전환 시 미러 비움 + history snapshot | history snapshot은 `school_history`에 보존(무관), 로컬 `s.school=''` 제거 |
| DB `app.js:3722`,`3783` import / `5912`,`6073` 시트일괄 (`school: ...`) | import/일괄생성 시 미러 저장 | 학부별 필드로 저장 전환(현재 단일 school만 → `school_current`/level 기준 SCHOOL_FIELD 매핑 필요) |
| **newtest** `cloudrun/src/index.js:711` `dscTempAttendanceData` | 진단평가 신청서가 students에 `school`만 write(`school_*` 없음) | **학부별 필드 작성으로 전환**(없으면 트리거 가드가 skip → 라벨 미생성) |
| (참고) DB `migrate-school-by-level.js:18`,`25` | 1회성 마이그레이션(미러 백필) | 제거 후 무용 |

> 주의: import/시트/newtest는 단일 `school`만 입력받는다. 미러 write 중단만으로는 부족하고, **입력 학교를 `SCHOOL_FIELD[level]`(학부별 필드)에 저장**하도록 함께 바꿔야 트리거 가드(`school_*` 존재 시에만 라벨생성)를 통과한다.

---

## 3. 자체 도메인 `school` (students 미러와 무관 — 제외 목록)

| 앱 | 위치 | 도메인 |
|----|------|--------|
| exam | `shared/types/exam-analysis.ts:56` 외 `analyses/*`, `app/(dashboard)/analyses`, `api/.../pdf/route.ts`, `schemas/examAnalysis.ts`, `lib/analyses/status.ts` | `ExamAnalysis.school`(시험분석 입력) |
| exam | `shared/types/external-score.ts`, `useExternalScores.ts`, `ExternalScorePanel` 의 `event.school`/`eventDraft.school`/`schoolEventFilter.school` | `ExternalScoreEvent.school`(외부성적표 이벤트 입력) |
| exam | `canonicalSchoolName`/`schoolMatchKey`/`isSameSchoolName` (`student-display.ts`) | 학교명 정규화·동등성 비교 헬퍼(자체) |
| newtest | `cloudrun` 진단신청서 form/시트의 `schoolName`/`school`(students write 제외 부분), `migrate-sheets-*.mjs` | diagnostic_application 자체 입력·시트 미러 |

→ 이들은 **절대 치환 금지.** `.school` 일괄 grep 치환 시 시험분석·외부성적표·진단신청서 데이터가 파손된다. exam `ExternalScorePanel`만 students(`studentSchool()`)와 이벤트(`event.school`)가 교차하므로 **students 쪽 1개 함수(`studentSchool`)만** `currentSchool`로 바꾼다.

---

## 4. 데이터 삭제 필요성 권고

- **권고: 필드 삭제하지 말고 dead data로 보존.**
- 근거: 모든 read를 `currentSchool`로 이전하고 모든 write를 중단하면, 기존 15,032건의 `school` 값은 **아무도 읽지 않는 무해한 잔여**가 된다. undefined 크래시 위험 없음(읽는 곳이 0이 된 상태이므로).
- 대량 삭제(`FieldValue.delete()` 배치)는 **이득 0 대비 위험 큼**: 쓰기 부하·트리거 재발화(15k write)·실수 시 복구 불가. firestore.rules `withinFieldLimit(30)`·whitelist 영향도 점검 필요.
- 만약 굳이 삭제한다면: **모든 read 이전 + write 중단 + 1주 모니터링(에러 0) 확인 후**, 200건/배치(승급 배치와 동일 한도), `accidental-data-loss-prevention` 절차로 **사용자 명시 승인** 받고 실행. status 무관 전수.

---

## 5. firestore.rules 영향 (4앱 동기화)

- `students` 화이트리스트(`hasOnlyAllowedStudentFields`)에 `school` **포함(허용)·필수 아님** → students에서 미러 write 중단해도 rules는 통과. **단 `school` 키를 화이트리스트에서 빼지 않아도 됨**(허용만이라 무해, 빼면 더 깔끔).
- ⚠ **별개 선결 이슈:** 현재 rules 화이트리스트에 `school_elementary/middle/high/school_level_grade`가 **없음.** DB saveStudent가 이 3필드를 client write하므로, **rules가 이미 갱신됐어야** 한다(미갱신이면 saveStudent가 rules-reject). 미러 제거 전 이 동기화 상태부터 확인 필요.
- ⚠ **`temp_attendance`(DSC, line 572-573)·`contacts`(DB, line 621)는 `school` 비어있지 않음을 require.** 이들은 students 미러가 아닌 자체 컬렉션이지만, 동일 `school` 명칭을 쓴다. **미러 제거와 무관(건드리지 말 것)** — 단 혼동 주의.
- rules 변경 시 `firestore-rules-sync` 스킬로 **DB/DSC/HR/exam 4개 동기화** 필수.

---

## 6. 위험도 + 단계별 제거 순서

**위험도: 높음** (필드 read 0화가 아니라 **매칭 로직 이전 3건 + 미관리 앱 수정 + rules 동기화**가 결합).

### 안전 제거 순서 (읽기 전환 → 쓰기 중단 → 데이터)

**Phase 0 — 선결 확인**
- rules에 `school_*` 화이트리스트 반영 상태 확인(미반영이면 먼저 동기화).
- newtest 담당자(자체 하네스) 확보 — 미관리 시 진행 보류.

**Phase 1 — 읽기 전환 (블로커 우선)**
1. **exam ExternalScorePanel** `studentSchool()`: `student.school` → `currentSchool(student)`. `isSameSchoolName` 정규화 비교 로직은 현행 유지(매칭 의미 보존). shared 이미 의존(v1.15.0).
2. **내신키 동시 이전(DB+DSC 원자적):** DB `naesinHelpers.deriveNaesinCode`(line 29)·`buildNaesinCsKey`와 DSC `DailyLogBoard.buildNaesinKey`(line 60)를 **동일하게** `currentSchool`로. 두 앱 키 생성식이 같은 학교값을 써야 매칭 유지 → **같은 배포 윈도우**에.
3. **newtest write 전환:** `dscTempAttendanceData`가 `school_*`(level 기준 SCHOOL_FIELD)에 학교 저장하도록. 미전환 시 newtest 생성 학생은 트리거 가드로 라벨 미생성.
4. **DB 표시/검색 잔여:** abbreviateSchool·naesin-schedule·school-normalizer(`collectKnownSchoolNames`/`schoolSearchTerms`)·past-history·promo-extractor·sheets export·consultationAiHandler → `currentSchool`. (난이도 낮음, 매칭 무관)
5. DB import/시트일괄(`app.js` 3722/3783/5912/6073)·saveStudent: 입력 학교를 `SCHOOL_FIELD[level]`에 저장하도록(이미 saveStudent는 schoolByLevel 저장 중 — `school` 키만 제거).

**Phase 2 — 쓰기 중단**
6. `onStudentLabelSync` 트리거의 미러 write 라인 제거(`functions-shared`, `firebase deploy --only functions:shared`).
7. DB saveStudent/applyBulkPromotion/import/시트의 `school` 키 제거(3필드 저장은 유지).
8. (선택) rules `students` 화이트리스트에서 `school` 제거 + 4앱 동기화.

**Phase 3 — 데이터 (선택, 비권고)**
9. 1주 모니터링 후에도 필요 시에만, 승인 받고 200건/배치 삭제. **기본은 dead data 보존.**

### 블로커 (이것들이 안 되면 제거 불가)
- **newtest**(전담 에이전트 없음, 미러 writer + 미마이그레이션 doc 생산) — **최우선.**
- **exam ExternalScorePanel**(미러 매칭 잔여).
- **DB↔DSC 내신키 동시 이전**(둘 중 하나만 바꾸면 키 불일치).

---

## 7. 오케스트레이터 인계
- HR·newtest(읽기)·DashBoard·consultation은 students.`school`을 **표시/매칭 목적으로 직접 소비하지 않음**(consultation은 full-doc spread만, DashBoard·HR은 school 미참조) → 읽기 측 무영향.
- newtest는 **쓰기 측에서만** 블로커. consultation의 `consultationAiHandler`(DB functions-shared)는 표시(LLM 프롬프트)라 낮은 난이도.
- 실제 제거 착수 전 본 분석의 Phase 0(rules 상태·newtest 담당) 확인을 선결 게이트로 둘 것.
