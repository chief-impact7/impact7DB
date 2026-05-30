# 전역 전환 코드리뷰 — DSC·exam·shared·newtest

리뷰 대상: shared `9df285a..HEAD`, DSC/exam/newtest 최근 전역 전환 커밋.
범위: 버그·회귀·엣지케이스. **리뷰만, 코드 수정 없음.**

---

## 🔴 CRITICAL

### C1. DSC `diagnostic.js` `_upsertStudentFromTemp` — 새 rules가 `school` write를 거부 (in-app 첫데이터입력 깨짐)
- **파일**: `impact7newDSC/diagnostic.js:237` (그리고 신규 생성 경로 `:253-259`)
- 이 함수는 학생을 `students` 컬렉션에 **client SDK(`auditSet`→`setDoc`)** 로 upsert한다. `baseFields`에 여전히 `school: data.school || ''` 를 쓰고 **`school_*` 는 쓰지 않는다**.
- 전역 전환 커밋 `dcb16bd`(DSC)·DB SSoT가 `firestore.rules`의 students whitelist `hasOnlyAllowedStudentFields()`에서 **`'school'` 을 제거**했다(`hasOnly(allowed)` 사용). client write는 rules 적용 대상 → **`school` 포함 write는 permission-denied로 거부**된다.
- 즉 DSC 앱의 "첫데이터입력(임시출결) → students upsert" 흐름이 **create/update 양쪽 모두 차단**된다. (rules: `allow create/update` 둘 다 `hasOnlyAllowedStudentFields()` 호출)
- newtest의 Cloud Run 경로(`cb4e65b`)는 마이그레이션됐으나, **병렬 경로인 DSC in-app `_upsertStudentFromTemp`는 누락**됐다. 해당 함수는 리뷰 지정 커밋엔 없지만 rules 변경이 라이브 회귀를 유발.
- **수정 제안**: newtest와 동일 패턴 적용 — `school` 줄을 제거하고
  ```js
  const SCHOOL_FIELD_BY_LEVEL = { '초등':'school_elementary','중등':'school_middle','고등':'school_high' };
  const f = SCHOOL_FIELD_BY_LEVEL[data.level];
  if (f && data.school) baseFields[f] = data.school;
  ```
  로 교체. `saveTempAttendance`가 level(초/중/고)을 필수 검증하므로 `f`는 항상 유효 → 누락 없음. (cached 갱신·신규 생성 경로 모두 baseFields 사용하므로 한 곳만 고치면 됨.)

---

## 🟠 MAJOR

### M1. newtest `upsertDscStudentFromTemp` — level 빈값 시 학교명 완전 유실
- **파일**: `newtest/cloudrun/src/index.js:605-606` (`dscLevelFromGrade` `:555-560`)
- `schoolField = SCHOOL_FIELD_BY_LEVEL[data.level]` 가 level 미매핑(`""`)이면 `undefined` → `school_*` 미저장. 구 `school` 미러도 제거됨 → **학교명이 students 문서에서 완전히 사라진다**.
- `dscLevelFromGrade`는 grade 텍스트가 초/중/고로 시작하지 않으면 `""` 반환(예: "1학년", 공란, 오타). 이 경우 DSC/DB의 라벨·csKey·검색이 학교 없이 표시.
- 단, `temp_attendance.school`(자체 컬렉션, `:630` 의 `data`)은 **보존됨** — 정상.
- **수정 제안**: level 미매핑 시 보정(grade로 추론 재시도) 하거나, 최소한 `console.warn`으로 유실을 로깅. 표시 파리티가 필요하면 level 빈값 케이스 fallback 정의.

### M2. DB `upsert-students.js` — bulk import가 `school` 미러만 쓰고 `school_*` 미저장 (out-of-scope이나 인접 회귀)
- **파일**: `impact7DB/upsert-students.js:257`, `school-normalizer.js:42-47`
- `normalizeStudentSchools()`는 `student.school`만 세팅하고 `school_*` 로 매핑하지 않음. admin SDK라 rules는 통과하지만, **bulk-import된 학생은 `school_*` 가 없어** 전역 전환 후 라벨/csKey/검색에서 학교가 비게 됨.
- DB app.js `:3722/:3783/:5931` 도 동일하게 `school` 만 구성 — client write면 rules 거부 위험(검증 필요).
- 리뷰 4개 repo 범위 밖이지만, 전역 전환 완결성 차원에서 별도 점검 권장.

---

## 🟡 MINOR

### m1. exam `student-display.ts` 주석/예시가 실제 동작과 불일치 (`[] vs ["중2"]`)
- **파일**: `impact7exam/src/shared/lib/student-display.ts` 재노출부 주석 + 커밋 `9fc88e2` 메시지 + `impact7-shared.d.ts:35` "학교 없으면 []".
- shared `studentSearchTerms`는 빈 학교 중2 → `["중2"]` 반환(`student-label.js:74 if(!school) return [full]`, 테스트 `:107` 도 `['중2']` 확정). 주석은 "학교없음 중2 → []" 로 표기.
- **동작 회귀 없음**: 기존 exam 로컬도 `[full]`(`["중2"]`) 반환했고 shared도 동일 → 동작 무변화. callsite는 substring match라 영향 무. 단 **문서/타입 주석이 거짓** → 오해 소지. `[]` 표기를 `["중2"]` 로 정정 권장.

### m2. shared `studentSearchTerms` — 엣지 테스트 누락(동작은 안전)
- **파일**: `impact7-shared/student-label.test.js:101-114`
- 프롬프트 우려 케이스 트레이스 결과 **모두 안전**:
  - 학교명 숫자 포함(`제3중` grade3 → `["제3","제3중","제3중3"]`): 비졸업 grade는 normalize로 단일자리(1~6)·라벨 말미에 정확히 append되므로 `endsWith(g)` slice가 학교 숫자를 오제거하지 않음.
  - 지역명 prefix(`서울XX중`), DUP_EXCEPT에서 level글자가 말미(`안중`중2 → `["안중","안중중","안중중2"]`), 학부≠말미글자(`윤중`초6) 모두 정상.
- 회귀 위험은 없으나 위 케이스를 핀 고정하는 테스트 부재 → 향후 정규식 변경 시 사일런트 드리프트 가능. 테스트 추가 권장(필수 아님).

### m3. exam `studentSearchTerms` d.ts 타입 — `currentSchool`/`studentSearchTerms` 필드 구체화 적정
- **파일**: `impact7exam/src/shared/types/impact7-shared.d.ts:15-20, 36-43`
- `currentSchool`·`studentSearchTerms` 모두 `school_*`/level/grade 만 선언 → TS2345(인덱스시그니처) 회피 의도 정확. exam `student.ts`의 `school_*` 타입과 일치. **문제 없음**. (단 m1의 JSDoc 문구만 부정확.)

---

## ✅ 검증 통과 (회귀 없음 확인)

- **csKey DB↔DSC 글자단위 일치**: DSC `student-helpers.js:106-143`(`buildNaesinCsKey`/`deriveNaesinCode`)·`DailyLogBoard.jsx:58-72`(`buildNaesinKey`) ↔ DB `functions/src/naesinHelpers.js:30-62`. 조립식 `branch+school+levelShort+grade+group` 동일, A/B 판별 로직 동일, `currentSchool` 정의(raw `school_<level>`) 동일(DB는 inline 미러). **일치**.
- **currentSchool import 경로**: DSC 루트 JS(`student-helpers.js`)·React(`DailyLogBoard.jsx`) 모두 `@impact7/shared/student-label` 에서 import. exam도 동일. **정상**.
- **shared studentFullLabel↔studentSearchTerms 출력 일관성**: searchTerms의 최구체항이 full 자체 → 표시·검색 정규화 일치. Set 중복제거 정상.
- **exam ExternalScorePanel 매칭 회귀**: `studentSchool` 입력만 `.school`→`currentSchool`로 교체, `isSameSchoolName`/`canonicalSchoolName`/`schoolMatchKey` 정규화·동등성 로직 보존. `event.school`(외부성적표 자체 도메인) 미변경. **회귀 0**.
- **newtest temp_attendance.school 보존**: `:630` `data`(school 포함) 그대로 write. students만 미러 제거. **정상**.
- **shared 테스트**: `node --test student-label.test.js` → 35 pass / 0 fail.

---

## 요약

| 심각도 | 건수 | 핵심 |
|--------|------|------|
| Critical | 1 | DSC `diagnostic.js:237` in-app 첫데이터입력이 `school`을 쓰는데 새 rules가 거부 → write 차단 |
| Major | 2 | newtest level 빈값 시 학교 유실(M1); DB bulk-import가 school_* 미저장(M2, 범위밖) |
| Minor | 3 | exam 주석/타입의 `[]` 표기 오류(m1); shared 엣지 테스트 누락(m2); d.ts 타입은 적정(m3) |

**핵심 4줄**
1. **즉시 조치 C1**: 전역 전환이 newtest Cloud Run 경로만 마이그레이션하고 DSC 앱 내 동등 경로(`_upsertStudentFromTemp`)를 놓쳐, rules가 `school`을 거부하면서 DSC "첫데이터입력 → students upsert"가 깨진다. C1의 SCHOOL_FIELD_BY_LEVEL 패턴으로 즉시 수정 필요.
2. **M1**: newtest는 grade가 초/중/고로 시작 안 하면 level=""→`school_*` 미저장+구 미러 제거로 학교명이 students에서 유실. fallback/경고 필요.
3. **shared studentSearchTerms 로직 자체는 견고** — 학교명 숫자·지역명·DUP_EXCEPT 엣지 모두 트레이스상 안전(비졸업 grade가 단일자리·라벨 말미 append라 오제거 없음). 다만 핀 테스트 부재(m2).
4. csKey DB↔DSC 글자단위 일치, exam 외부성적표 매칭·event.school 보존, newtest temp_attendance.school 보존 모두 확인 — 이들 경로 회귀 없음.
