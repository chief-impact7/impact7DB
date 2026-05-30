# 27. DB 내신 csKey `.school` → `currentSchool` 이전 — 구현 결과

작성: 2026-05-30 · 상태: **구현 완료 (커밋·푸시·배포 안 함)**
범위: 블로커 ②(구 `school` 미러 제거 후속 1번) 동시 이전 — **DB 측 2곳**
근거: `_workspace/25`(분석), `_workspace/26`(audit, stale=0 게이트 통과), DSC 측 산출물 `_workspace/28`(교차 대조)
shared: DB front는 `@impact7/shared/student-label` import 사용(app.js·migrate-school-by-level.js 선례). functions(leave-request)는 **`@impact7/shared` 미의존** → inline 미러.

---

## 0. 핵심 결론 (반환용)

- DB 2곳 변경. **(1) `functions/src/naesinHelpers.js` `deriveNaesinCode`**(매칭 핵심, csKey 생성): `student.school || ''` → `currentSchool(student)`. **(2) `naesin-schedule.js`**(csKey 아님, 표시/그룹핑): label·groupKey의 `s.school` → `currentSchool(s)`.
- currentSchool 조달: **functions = inline**(package.json에 `@impact7/shared` 의존 없음 — firebase-admin/functions만), **DB front = import**(`@impact7/shared/student-label`, 기존 선례).
- 키 식 구조(branch·levelShort·grade·A/B group·구분자·조립 순서) **단 한 글자도 불변** — diff상 변경은 school 소스 대입뿐. DSC 산출물 §5 식과 글자 단위 일치 확인.
- 표본 3건(`2단지대일고1B`·`10단지신남중1B`·`2단지신목중2B`) old==new 동일 재현. functions 단위 테스트 34/34 통과(naesinHelpers 24 + cleanup 10), DB front Vite build 성공.

---

## 1. 변경 지점

### ① `functions/src/naesinHelpers.js` — `deriveNaesinCode` (매칭 핵심)

csKey 생성·cleanup/syncNaesinPeriod 매칭의 주체(분석 25 §0-1, §4). **functions는 `@impact7/shared` 미의존**이라 `currentSchool`을 inline 미러로 추가.

```diff
 const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };
+// 현재 학부의 학교명 소스. @impact7/shared의 currentSchool과 동일(정규화 없는 raw).
+// functions(leave-request)는 @impact7/shared 미의존 → inline 미러.
+const SCHOOL_FIELD = { '초등': 'school_elementary', '중등': 'school_middle', '고등': 'school_high' };
+function currentSchool(student) {
+    return student?.[SCHOOL_FIELD[student?.level]] || '';
+}
 export const NAESIN_OVERRIDE_EXCLUDE = '';
 ...
 export function deriveNaesinCode(student, enrollment) {
-    const school = student.school || '';
+    const school = currentSchool(student);
     const levelShort = LEVEL_SHORT[student.level] || '';
     const grade = student.grade || '';
     if (!school || !grade) return '';
```

- `buildNaesinCsKey({ school, ... })`(line 24)·`resolveNaesinCsKey`(branch 접두, line 58)는 **무변경** — school 소스만 `deriveNaesinCode` 한 곳에서 바뀜.
- inline `currentSchool`은 shared `student-label.js`의 정의(`student?.[SCHOOL_FIELD[student?.level]] || ''`)와 글자 단위 동일. SCHOOL_FIELD 매핑도 동일(초등→school_elementary, 중등→school_middle, 고등→school_high). **정규화·trim 없음.**

#### currentSchool 조달: inline 근거
- `functions/package.json` dependencies = `firebase-admin`, `firebase-functions`만. **`@impact7/shared` 없음.** leave-request codebase는 모노레포 shared 패키지를 빌드 의존으로 끌어오지 않으므로 import 불가 → inline.
- shared 버전 추가 회귀 주의(지시): shared를 functions 의존에 새로 넣지 **않음**(다른 leave-request 함수 빌드/배포 영향 0). inline 미러는 DSC가 import하는 shared `currentSchool`과 동일 출력을 보장하면 충분하며, 매칭은 "같은 출력"으로 성립(같은 코드 경로일 필요 없음).

### ② `naesin-schedule.js` — 표시/그룹핑 (csKey 아님, 독립 안전)

분석 25 §1 ④·§0: groupKey에 **branch·A/B group이 빠진** DB 내신 시간표 모달 전용 로컬 그룹핑. class_settings doc id로 저장되지 않고 CF 매칭에도 안 쓰임 → **csKey 매칭과 무관**. 표시 일관성 위해 함께 이전. currentSchool은 DB front 선례대로 import.

```diff
 import { cleanSchoolName, levelShortName } from './school-normalizer.js';
+import { currentSchool } from '@impact7/shared/student-label';
 ...
 function abbreviateSchool(s) {
-    const school = cleanSchoolName(s.school)
+    const school = cleanSchoolName(currentSchool(s))
         .replace(/고등학교$/, '')...   // 감싸는 가공(cleanSchoolName + 접미사 제거)은 무변경
 ...
 function buildNaesinGroups() {
     for (const s of targets) {
-        const school = s.school || '학교미입력';
+        const school = currentSchool(s) || '학교미입력';
         const grade = s.grade || '?';
         const key = `${school}_${s.level}_${grade}`;   // groupKey 식 무변경
```

- 두 자리 모두 **school 소스만 currentSchool로 교체**, 감싸는 가공(`cleanSchoolName(...)`, `|| '학교미입력'`)은 기존 그대로 유지. groupKey 식 `${school}_${level}_${grade}` 불변.
- import 경로 `@impact7/shared/student-label`는 app.js:13(`currentSchool, SCHOOL_FIELD`)·migrate-school-by-level.js:2와 동일 패턴 → 안전, Vite build로 재확인.

---

## 2. 키 식 불변 증명 (diff에서 .school만 바뀜)

`git diff` 실제 변경:
- `functions/src/naesinHelpers.js`: (a) inline `SCHOOL_FIELD`+`currentSchool` 헬퍼 추가, (b) `deriveNaesinCode` 내 `const school` 우변 1줄 교체. **키 조립 코드 전부 무변경.**
  - `buildNaesinCsKey` = `${branch||''}${school||''}${level||''}${grade||''}${group||''}` (line 24~26, 무변경)
  - `resolveNaesinCsKey` = `branchFromStudent(student) + nCode` (line 58~67, 무변경)
  - A/B group 판별(끝글자 A/B 직접표기 우선 → 홀=A/짝=B → 정규/자유학기 enrollment fallback, line 35~53), LEVEL_SHORT(초/중/고), `!school || !grade` guard — 전부 무변경.
- `naesin-schedule.js`: import 1줄 + school 소스 2자리. groupKey·label 조립식 무변경(csKey 아님).

**school 출처 동치성:** 기존 `student.school || ''`는 falsy면 `''`. inline `currentSchool = student?.[SCHOOL_FIELD[student?.level]] || ''`도 학부필드 없으면 `''`. 정상 학생은 `.school == currentSchool`(audit 26 §2: 활성 내신 341명 stale=0) → 동일 값. **가공·trim·정규화 일절 없음** — raw 그대로 키 진입(분석 25 §1 ① "정규화 없음"과 일치).

---

## 3. 표본 old==new 검증

`naesinHelpers.js`의 `resolveNaesinCsKey`/`deriveNaesinCode`를 직접 import해, 학부필드(`school_high`/`school_middle`)에 audit 표본 학교명을 넣고 B-group이 나오도록 정규 class_number 끝자리 짝수로 호출(audit 26 §4 재현):

| 학생 | level/grade | currentSchool 소스 | got (new=currentSchool) | expect | 일치 |
|------|------------|---------------------|--------------------------|--------|------|
| 강건 | 고등/1 | school_high='대일' | `2단지대일고1B` | `2단지대일고1B` | ✅ |
| 강민재 | 중등/1 | school_middle='신남' | `10단지신남중1B` | `10단지신남중1B` | ✅ |
| 강서연 | 중등/2 | school_middle='신목' | `2단지신목중2B` | `2단지신목중2B` | ✅ |

정상 학생은 `.school == currentSchool`(audit)이라 old(.school 기반)와 new(currentSchool 기반)가 동일 토큰 → 키 글자 단위 보존 → `class_settings/{csKey}` doc id 재사용, CF 매칭 무손상. **ALL PASS** (임시 스크립트 `/tmp/naesin_unit_test.mjs`, 검증 후 폐기).

---

## 4. 단위 테스트 / 빌드 결과

- **functions 단위 테스트:** `naesinHelpers.test.js` 24 + `cleanup.test.js` 10 = **34/34 통과**.
  - 픽스처 갱신: 두 테스트가 구 미러 필드 `school: '...'`로 키를 유도했으나, 이제 `deriveNaesinCode`가 currentSchool(학부필드)을 읽으므로 **픽스처를 `school_middle: '...'`로 갱신**(level이 전부 중등). 이는 회귀가 아니라 키 소스 이전의 정확한 반영(테스트가 신 동작 검증). `naesinHelpers.test.js`: baseStudent·student·school-없음 케이스 / `cleanup.test.js`: `_countNaesinStudents`·`runClassCleanup` 내신 픽스처 3자리.
- **integration 테스트:** `syncNaesinPeriod.integration.test.js`·`finalize.integration.test.js`는 실패하나 **사전 환경 문제**(firebase-functions-test "Hook timed out 10000ms"). 내 변경을 stash한 baseline에서도 syncNaesinPeriod 8/8 동일 타임아웃 → **본 변경과 무관**. syncNaesinPeriod는 override 문자열 비교만 하고 school 재생성 안 함(분석 25 §4)이라 로직상으로도 무영향.
- **DB front Vite build:** `npx vite build` 성공 — vite v7.3.2, 36 modules transformed, `dist/assets/index-*.js` 522.61 kB. >500kB 경고는 기존부터 존재(무관).
- **functions lint:** `npx eslint src/naesinHelpers.js` EXIT=0.

---

## 5. 교차 대조용 — DB csKey 최종 생성식 (DSC와 일치 확인)

DB `naesinHelpers.js`(①)의 **최종 csKey 조립식**:

```
csKey = branch + school + levelShort + grade + group     // 구분자 없음, 직접 연결

  branch     = branchFromStudent(student)
               = student.branch
                 ?? (정규/자유학기 enrollment.class_number 첫 글자 '1'→'2단지', '2'→'10단지', else '')
  school     = currentSchool(student)          // = student[SCHOOL_FIELD[level]] || '', raw·무가공
               SCHOOL_FIELD = { 초등: school_elementary, 중등: school_middle, 고등: school_high }
  levelShort = { 초등:'초', 중등:'중', 고등:'고' }[student.level] || ''
  grade      = student.grade || ''
  group      = A/B :
                 enrollment.class_number 끝글자 'A'|'B' → 그 글자
                 else 끝글자 숫자 d → d%2===1 ? 'A' : 'B'
                 group 미정 시 → 정규/자유학기 enrollment.class_number 끝자리로 동일 판별
  guard      = !school || !grade → 코어 '' 반환 → csKey 없음(내신 매칭 탈락)
```

- **조립 순서:** `branch → school → levelShort → grade → group`, **구분자 0**(템플릿 리터럴 직접 연결).
- 구현 경로: `deriveNaesinCode`가 코어를 `buildNaesinCsKey({school, level:levelShort, grade, group})`로 만들고, `resolveNaesinCsKey`가 `branchFromStudent(student) + 코어`로 접두 → 결과 문자열은 위 식과 동일.
- override 경로: `naesin_class_override`가 string이면 그 문자열을 그대로 csKey로 사용(school 재생성 안 함) → 이전 영향 0.

### DSC 산출물(`_workspace/28` §5)과 대조 결과 — **완전 일치**
| 항목 | DB(①, 본 작업) | DSC(②③, 28번) | 일치 |
|------|----------------|-----------------|------|
| 조립 순서 | branch→school→levelShort→grade→group | 동일 | ✅ |
| 구분자 | 없음(직접 연결) | 없음 | ✅ |
| school 소스 | `currentSchool(student)` raw·무가공 | 동일 | ✅ |
| SCHOOL_FIELD | 초등/중등/고등→elementary/middle/high | 동일 | ✅ |
| levelShort | 초/중/고 | 동일 | ✅ |
| A/B group 규칙 | 끝글자 A/B→홀=A짝=B→정규 fallback | 동일 | ✅ |
| guard | `!school||!grade` | 동일(루트) | ✅ |
| 표본 키 | 2단지대일고1B·10단지신남중1B·2단지신목중2B | 동일 | ✅ |

> 기존 차이(분석 25 §1): branch 유도가 DB①은 `regular.class_number`, DSC②③은 `enrollments[0].class_number`. 이는 **이번 이전 이전부터 존재한 현행 차이**이고 school 토큰 교체와 무관 → 본 작업 범위 밖(양 산출물 합의).

---

## 6. 미수행 (지시대로)

- 커밋·푸시·**배포 안 함**. 배포(`firebase deploy --only functions:leave-request` + DB hosting)는 DSC hosting과 동시에 오케스트레이터 조율.
- 기존 저장 키 마이그레이션 안 함 — class_settings doc id·`naesin_class_override` 그대로 유효(정상 학생 새 키 == 기존 doc id).
- functions/index.js(leave-request)에 무관 코드 추가 없음.
- `students` 컬렉션 write 0건(코드 수정만).
