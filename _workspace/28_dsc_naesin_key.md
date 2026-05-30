# 28. DSC 내신 csKey `.school` → `currentSchool` 이전 — 구현 결과

작성: 2026-05-30 · 상태: **구현 완료 (커밋·푸시·배포 안 함)**
범위: 블로커 ②(구 `school` 미러 제거 후속 1번) 동시 이전 — **DSC 측 2곳**
근거: `_workspace/25`(분석), `_workspace/26`(audit, stale=0 게이트 통과)
shared: `@impact7/shared#v1.15.0` (설치 확인), export `./student-label` → `currentSchool`

---

## 0. 핵심 결론 (반환용)

- DSC 2곳(`student-helpers.js` `deriveNaesinCode`, `DailyLogBoard.jsx` `buildNaesinKey`)에서 학교값 출처만 `student.school || ''` → `currentSchool(student)`로 교체. 각 파일에 `import { currentSchool } from '@impact7/shared/student-label'` 추가.
- 키 식 구조(branch·levelShort·grade·A/B group·구분자·문자열 조립 순서)는 **단 한 글자도 불변** — diff상 변경은 import 1줄 + school 대입 1줄뿐(파일당 +2/-1).
- 표본 3건(`2단지대일고1B`·`10단지신남중1B`·`2단지신목중2B`) old==new 동일·expect 일치 확인. `currentSchool`은 학부필드 없으면 `''` 반환 → 기존 `|| ''` fallback과 동치.
- Vite build 성공(748 모듈), 테스트 19/19 통과. 기존 저장 키 마이그레이션 없음.

---

## 1. 변경 지점

### ① `impact7newDSC/student-helpers.js` — `deriveNaesinCode` (line ~111)
실제 csKey 생성·`class_settings` doc id 저장의 주체(분석 25 §0-1, §2).
```diff
+import { currentSchool } from '@impact7/shared/student-label';
 ...
 export function deriveNaesinCode(student, enrollment) {
-    const school = student.school || '';
+    const school = currentSchool(student);
     const levelShort = LEVEL_SHORT[student.level] || '';
     const grade = student.grade || '';
     if (!school || !grade) return '';
```
- `resolveNaesinCsKey`(line 152)는 `branchFromStudent(student) + deriveNaesinCode(...)`로 csKey를 조립 — 이 함수가 만든 코어가 doc id로 영속.

### ② `impact7newDSC/src/dashboard/components/DailyLogBoard.jsx` — `buildNaesinKey` (line ~57)
React 측 csKey 재생성·매칭(daily log 내신 그룹·class_settings 조회).
```diff
+import { currentSchool } from '@impact7/shared/student-label';
 ...
 function buildNaesinKey(student, enrollment) {
     const levelShort = levelShortMap[student.level] || '';
-    const school = student.school || '';
+    const school = currentSchool(student);
     const grade = student.grade || '';
```

---

## 2. 키 식 불변 증명 (diff에서 .school만 바뀜)

`git diff --stat`: `student-helpers.js` +2/-1, `DailyLogBoard.jsx` +2/-1. 각 파일에서 실제 변경 라인은 (a) import 추가 1줄, (b) `const school = ...` 우변 교체 1줄. 키를 조립하는 코드는 손대지 않음:

- 루트: `buildNaesinCsKey({ school, level: levelShort, grade, group })` → `${branch||''}${school||''}${level||''}${grade||''}${group||''}` (조립 함수 line 105 무변경), branch는 `resolveNaesinCsKey`에서 `branchFromStudent(student) + nCode` (line 160 무변경).
- React: `return \`${getBranch(student)}${school}${levelShort}${grade}${group}\`;` (line 71 무변경).
- A/B group 판별(class_number 끝자리 A/B 직접표기 우선 → 홀=A/짝=B → 정규 enrollment fallback), LEVEL_SHORT 매핑(초/중/고), `!school || !grade`(루트)·`!school || !grade || !group`(React) guard — 전부 무변경.

**school 출처 동치성:** 기존 `student.school || ''`는 falsy면 `''`. `currentSchool(student) = student[SCHOOL_FIELD[student.level]] || ''`(shared `student-label.js:12-14`)도 학부필드 없으면 `''`. 정상 학생은 `.school == currentSchool`(audit 26 §2: 활성 내신 341명 stale=0)이라 동일 값. **가공·trim·정규화 일절 없음** — raw 값 그대로 키에 진입(분석 25 §3, §1 ②③ "정규화 없음"과 일치).

---

## 3. 표본 old==new 검증

`@impact7/shared/student-label`에서 `currentSchool`을 import하고 두 함수의 키 식을 그대로 복제해 `school=.school`(old) vs `school=currentSchool`(new) 출력 비교 (audit 26 §4 표본 3건 재현, B-group이 나오도록 정규 class_number 끝자리 짝수 입력):

| 학생 | level/grade | school = school_* | old(.school) | new(currentSchool) | expect | old==new |
|------|------------|-------------------|--------------|--------------------|--------|----------|
| 강건 | 고등/1 | 대일 | `2단지대일고1B` | `2단지대일고1B` | `2단지대일고1B` | ✅ |
| 강민재 | 중등/1 | 신남 | `10단지신남중1B` | `10단지신남중1B` | `10단지신남중1B` | ✅ |
| 강서연 | 중등/2 | 신목 | `2단지신목중2B` | `2단지신목중2B` | `2단지신목중2B` | ✅ |

추가: `currentSchool({level:'고등', school_high:'대일'})='대일'`, `currentSchool({level:'고등'})=''` (학부필드 누락 시 빈 문자열 → 기존 fallback과 동치). 결과: **ALL PASS** (검증 후 임시 스크립트 삭제).

---

## 4. 빌드 / 테스트 결과

- **Vite build:** `npm run build` 성공 — vite v7.3.1, 748 modules transformed, dashboard 청크(607.59 kB)에 React 변경 반영. >500kB 청크 경고는 기존부터 존재(이번 변경 무관).
- **테스트:** `npm test` (`consultation-filter.test.js`, `consultation-payload.test.js`) — **pass 19 / fail 0**.
- import 경로 검증: `@impact7/shared/student-label`은 React 측(`src/shared/firestore-helpers.js`가 `studentFullLabel` import)과 루트 vanilla 측(`school-normalizer.js`가 `SCHOOL_FIELD` import) 양쪽에서 이미 사용 중 → 신규 경로 추가 안전, 빌드로 재확인됨.

---

## 5. 교차 대조용 — DSC csKey 최종 생성식 (DB 에이전트와 일치 필수)

DB `naesinHelpers.js`(①)와 글자 단위 동일해야 하는 **DSC 측 최종 csKey 조립식**:

```
csKey = branch + school + levelShort + grade + group     // 구분자 없음, 직접 연결

  branch     = branchFromStudent(student)
               = student.branch
                 ?? (enrollments[0].class_number 첫 글자 '1'→'2단지', '2'→'10단지', else '')
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
- 루트 `student-helpers.js`: 코어를 `buildNaesinCsKey({school,level:levelShort,grade,group})`로 만들고 `resolveNaesinCsKey`가 `branch + 코어`로 접두 — 결과 문자열은 위 식과 동일.
- React `DailyLogBoard.jsx`: `buildNaesinKey`가 한 함수에서 `${getBranch}${school}${levelShort}${grade}${group}` 직접 조립 — 결과 동일. (단 React guard는 `!school||!grade||!group`로 group까지 요구 — 기존부터의 차이, 이번 이전 무관.)
- **override 경로:** `naesin_class_override`가 string이면 그 문자열을 그대로 csKey로 사용(school 재생성 안 함) → 이전 영향 없음(저장 스냅샷 보존).

> DB ① `deriveNaesinCode`/`buildNaesinCsKey`도 `student.school` → `currentSchool(student)`로만 바뀌고 위 조립식(순서·구분자 없음·A/B 규칙·branch 규칙)이 글자 단위 동일해야 매칭 성립. branch 유도가 ①은 `regular.class_number`, ②③은 `enrollments[0].class_number`인 기존 차이(분석 25 §1)는 이번 범위 밖(school 토큰만 교체).

---

## 6. 미수행(지시대로)

- 커밋·푸시·**배포 안 함** (배포는 DB와 동시에 오케스트레이터 조율).
- 기존 저장 키 마이그레이션 안 함 — class_settings doc id·`naesin_class_override` 그대로 유효(정상 학생 새 키 == 기존 doc id).
- `students` 컬렉션 write 0건 (코드 수정만).
