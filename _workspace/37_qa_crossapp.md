# 37. 크로스앱 정합성 QA — 전역 전환(구 school 미러 제거 + 검색어 shared 공통화)

검증일 2026-05-30. 대상: DB / DSC / exam / HR / newtest / shared. 코드 수정 없음(검증·발견만).

## 결과 요약
- 항목1 내신 CS키 3곳 일치: **FAIL (critical 1)** — DailyLogBoard.jsx 브랜치 유도 분기
- 항목2 검색어 shared 통일: **PASS**
- 항목3 firestore.rules 4앱 동일: **PASS**
- 항목4 미러 제거 완전성: **FAIL (critical 1, major 2)** — upsert/import 스크립트 + DSC 읽기 잔존
- 항목5 기존 불변 규율: **PASS**

종합 판정: **critical 2건, major 2건**. shared 통일·rules·트리거·app.js·newtest 본선 경로는 깨끗하나, (a) DailyLogBoard 내신키 브랜치 유도가 정본과 갈라지고, (b) CSV 임포트 스크립트가 미러를 재생산/거부되며, (c) DSC 일부 화면이 사라진 `s.school`을 읽는다.

---

## 항목1 — 내신 CS키 3곳 글자단위 일치 : FAIL (critical)

세 빌더 비교:
- DB `functions/src/naesinHelpers.js` `deriveNaesinCode`/`buildNaesinCsKey` (L31-66) — `currentSchool` 인라인 미러(L8-10) = `student?.[SCHOOL_FIELD[student?.level]]||''`.
- DSC `student-helpers.js` `deriveNaesinCode`/`buildNaesinCsKey` (L106-142) — `currentSchool`은 `@impact7/shared/student-label` import(L7).
- shared `student-label.js` `currentSchool` (L12-13) = `student?.[SCHOOL_FIELD[student?.level]]||''`.

→ DB 인라인 미러와 shared 정의는 **글자단위 동일**, `SCHOOL_FIELD` 맵도 동일. DB·DSC `deriveNaesinCode`/`buildNaesinCsKey`/`resolveNaesinCsKey` 본문 char-identical. 브랜치는 둘 다 `branchFromStudent`(정규/자유학기 enrollment의 class_number 첫자리)로 `resolveNaesinCsKey`에서 prepend. 단위테스트 통과(DB 24/24, shared 35/35). → **이 둘은 PASS**.

**[FAIL-1 / critical] DailyLogBoard.jsx `buildNaesinKey`가 정본과 갈라짐**
- 위치: `impact7newDSC/src/dashboard/components/DailyLogBoard.jsx` `getBranch`(L43-50), `buildNaesinKey`(L58-73), `resolveNaesinKey`(L83-89). 이 키는 표시용이 아니라 `class_settings[key]`로 내신 기간 매칭에 직접 사용됨(`hasAutoNaesin` L95-98, `virtualNaesinEnrollment` L101-104).
- 문제 1 (브랜치 소스 불일치): `getBranch`(L45)는 `enrollments[0].class_number` 첫자리를 사용. 정본 `branchFromStudent`(naesinHelpers/student-helpers)는 **정규/자유학기** enrollment의 class_number 첫자리를 사용. `enrollments[0]`가 내신·특강 등 비정규 항목이고 그 class_number 첫자리가 다르면 브랜치 prefix가 갈라져 → 동일 학생인데 DailyLogBoard만 다른 csKey 산출 → class_settings 미스매치(내신 기간 오판정).
- 문제 2 (group 폴백 부재): `buildNaesinKey`는 `!group`이면 `''` 반환(L71). 정본 `deriveNaesinCode`는 group 불명 시 정규 enrollment 끝자리에서 A/B를 추론(naesinHelpers L52-61). 끝자리가 A/B/숫자가 아닌 내신 enrollment를 넘기면 DailyLogBoard만 키 생성 실패.
- 문제 3 (EXCLUDE 센티넬): `resolveNaesinKey`(L85-87)는 `naesin_class_override`가 `''`(EXCLUDE 센티넬)일 때 그대로 `''` 반환 → falsy라 매칭 안 됨(우연히 정합). 정본 `resolveNaesinCsKey`는 명시적으로 `null` 반환. 동작은 같으나 계약이 암묵적.
- 심각도: **critical** (내신 매칭 깨짐 가능). 단 정규반 첫 enrollment가 보통 enrollments[0]이면 다수 케이스는 우연히 일치 → 잠복.
- 권장 수정: DailyLogBoard가 `student-helpers.js`의 `resolveNaesinCsKey`/`deriveNaesinCode`/`branchFromStudent`를 직접 import해 자체 `buildNaesinKey`/`getBranch`/`resolveNaesinKey`를 제거(단일 정본화). 최소한 `getBranch`를 `regularEnrollment` 기준으로 교정.

---

## 항목2 — 검색어 shared 통일 : PASS

- DB `school-normalizer.js` L60, DSC `school-normalizer.js` L3, exam `src/shared/lib/student-display.ts` L32 모두 `export { studentSearchTerms as schoolSearchTerms } from '@impact7/shared/student-label'`로 재노출.
- 3앱 `package.json` 모두 `github:chief-impact7/impact7-shared#v1.16.0` (DB:28, DSC:13, exam:15).
- 3앱 package-lock `resolved` SHA 모두 `1ab502586adc91168b7cd1ce6a49b79bb4da73a8` (= v1.16.0).
- callsite 계약: `studentSearchTerms`는 배열 반환(shared L74-75, `return [full]` / `Array.from(new Set([...]))`). DSC callsite(class-student-search L72, role-memo L362, leave-request L584, class-setup L870)는 `.map`/`.some`로 배열 소비 → 호환. shared 테스트 35/35 통과(빈 학교→`['중2']`, 배열 보장).

---

## 항목3 — firestore.rules 4앱 동일 : PASS

- DB/DSC/HR/exam `firestore.rules` 4개 모두 md5 `84c24dfdc8818a0663863374825b58c6`, 1117줄, byte-identical (diff 무차이).
- students allowed 필드(L57-77): `school_elementary`·`school_middle`·`school_high`·`school_level_grade` 있음, **bare `school` 없음**. `hasOnly(allowed)` + `withinFieldLimit(35)` (L92, L98) 적용.

---

## 항목4 — 미러 제거 완전성 : FAIL

본선 경로는 깨끗:
- DB `app.js` 라이브 업서트 `runUpsertFromRows`: `infoFields`(L3811)에 bare school 없음, school은 `SCHOOL_FIELD[level]` 필드로만 기록(L3846-3852). L3722/L5931의 `school:`은 입력파싱 임시객체일 뿐 students write 아님.
- DB 트리거 `functions/`: students에 `school:` 미러 write/read 0건.
- newtest `cloudrun/src/index.js` `upsertDscStudentFromTemp`: students write가 `SCHOOL_FIELD_BY_LEVEL`로만 기록(L604-606), bare school 없음. 나머지 `data.school`(L531/576/723/1216/1255/1394/1397)은 자체 신청서 시트/메일/HTML 도메인.
- exam: 모든 `school` 히트는 자체 `ExamAnalysis`/`growth-report` 도메인(`exam-analysis.ts:56 school:string`, repository where 절 등) — 제외 대상.

**[FAIL-2 / critical] upsert-students.js가 미러 `school`을 students에 재기록**
- 위치: `impact7DB/upsert-students.js` L257(`school: cleanSchoolName(...)`), L136-137 `diffBasicInfo` fields에 `'school'` 포함, L323 `writes.push({docId, data: incoming, type:'set'})`. `school-normalizer.js normalizeStudentSchools`(L42-47)도 `student.school`에 되써 미러를 유지.
- 문제: firebase-admin SDK 사용(L20, L68 — 규칙 우회)이라 신규/변경 학생 doc에 bare `school` 필드가 **그대로 기록됨** → 방금 제거한 미러를 `npm run upsert` 한 번에 부활. school_* 매핑 없음(파일 내 `school_`/`SCHOOL_FIELD` 0건).
- 심각도: **critical** (미러 재생산). 스크립트는 `package.json` scripts `upsert`/`upsert:dry`로 라이브.
- 권장 수정: app.js와 동일하게 입력 `school`을 `SCHOOL_FIELD[level]`로 매핑하고 bare `school` write·diff 제거. `normalizeStudentSchools`도 school_* 대상으로 정규화하거나 입력단계 임시필드로 한정.

**[FAIL-3 / major] import-students.js가 미러를 write → 이제 규칙에 의해 거부됨**
- 위치: `impact7DB/import-students.js` L146(`school:`), L183 `batch.set(doc(...,'students'), student)`.
- 문제: 클라이언트 SDK 사용(L11-12 `firebase/firestore`). students rules의 `hasOnly(allowed)`가 bare `school`를 불허 → 이 임포트는 이제 **permission-denied로 실패**. school_* 매핑 없음.
- 심각도: **major** (스크립트 깨짐, 데이터 오염은 아님). `npm run import` 라이브.
- 권장 수정: upsert와 동일하게 SCHOOL_FIELD 매핑 후 bare school 제거.

**[FAIL-4 / major] DSC 일부 화면이 사라진 `s.school`을 읽음**
- 위치(students 객체 직접 read):
  - `daily-ops.js` 검색 필터 L1585·L1673·L1788·L1886 (`s.school?.toLowerCase().includes(q)`)
  - `export-report.js` L179 (`s.school || ''` — 시트 export '학교' 컬럼)
  - `past-history.js` L477 (`student.school || '—'` — 이력 헤더 학교 표시)
- 문제: DSC는 로드한 student 객체에 `currentSchool` 파생 `.school`을 채우지 않음(채우는 곳은 deriveNaesinCode 내부뿐). 미러 제거 후 doc에 `.school` 없으면 이 read들은 `undefined` → 검색에서 학교 매칭 누락, export '학교' 공란, 이력 헤더 '—'.
- 심각도: **major** (표시/검색 기능 저하, 데이터 손상은 아님). 이번 세션 커밋(8a8cad6·cfeb812·b431c80·dcb16bd)이 csKey·검색·라벨·rules는 옮겼으나 이 세 read 사이트는 미이전.
- 권장 수정: 이 사이트들을 `currentSchool(s)`(shared) 또는 `studentFullLabel` 기반으로 교체. 검색은 이미 도입된 `schoolSearchTerms(s)` 사용으로 통일(daily-ops 검색이 schoolSearchTerms 미사용 — class-student-search/role-memo/leave-request와 불일치).
- 참고(제외): DSC `class-setup.js`/`diagnostic.js`/`state.js TEMP_FIELD_LABELS`의 `school`은 class-setup planner(temp row)·`temp_attendance`·`contacts` 자체 도메인 → 미러 아님.

---

## 항목5 — 기존 불변 규율 : PASS
- 내신/자유학기 파생(`class_type==='정규'||'자유학기'`) 정본 동일(naesinHelpers·student-helpers·DailyLogBoard `REGULAR_CLASS_TYPES`). class_settings doc id(csKey) 형식 빌더 단일화 유지.
- enrollment↔status: 이번 변경은 school 도메인 한정, status 가드/퇴원 처리 미접촉. app.js 업서트의 비활성 상태 enrollment 가드(L3854-3857) 유지.
- shared 테스트 35/35, DB naesinHelpers 24/24 통과 → 파생 회귀 없음.
