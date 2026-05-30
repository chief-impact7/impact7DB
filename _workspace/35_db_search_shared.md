# DB 검색어 shared 공통화 (전역 전환 잔여 2번 — DB 교체)

분석: `30_search_terms_shared_analysis.md` §6 단계 5 이행. **DB 검색 회귀 교정** 작업.

## 변경 지점

| 파일 | 변경 |
|------|------|
| `package.json:28` | `@impact7/shared` `#v1.15.0` → `#v1.16.0` |
| `package-lock.json` | `npm install`로 갱신 (commit `1ab5025…`, v1.16.0) |
| `school-normalizer.js:60-69` | 로컬 `schoolSearchTerms`(raw 합성) 삭제 → shared 재노출 1줄 |

## bump

- `npm install @impact7/shared` → 1 package changed.
- **github 캐시 검증**: `node_modules/@impact7/shared/student-label.js:55`에 `studentSearchTerms` 존재 확인. lock의 resolved 커밋도 v1.16.0 태그 가리킴(`1ab502586…`).

## 교체 방식

```js
// 삭제된 로컬 구현(raw 학교명 합성, 정규화·예측학부·졸업 미적용)
// → 한 줄 재노출로 이름 보존:
export { studentSearchTerms as schoolSearchTerms } from '@impact7/shared/student-label';
```

- 같은 파일의 다른 export(`cleanSchoolName`/`levelShortName`/`collectKnownSchoolNames`/`normalizeSchoolName`/`normalizeStudentSchools`) **모두 유지**.
- `schoolOf(s) = currentSchool(s) || s?.school` 헬퍼는 `collectKnownSchoolNames`/`normalizeStudentSchools`가 계속 사용하므로 유지. **import 임시객체 `|| s?.school` 폴백은 이제 `schoolSearchTerms` 경로와 무관**(shared는 `currentSchool`→`studentFullLabel`로 역산). students.school 미러는 이미 삭제됨 → 폴백 무효지만 무해(검색 경로에 영향 없음).

## 2 callsite 무수정 확인

- `app.js:5` import 라인에서 `schoolSearchTerms`를 `./school-normalizer.js`에서 그대로 import (이름 보존으로 무변경).
- `app.js:842` (과거학생검색), `app.js:1209` (필터검색) 둘 다 `schoolSearchTerms(s).some(v => v.toLowerCase().includes(term))` 형태 — 배열 반환 계약 동일, **무수정**.
- 그 외 `schoolSearchTerms` 사용처 없음(grep 확인).

## old/new 검색어 비교 (회귀 교정 — 사용자 체감 변화)

raw 풀네임 합성 → 정규화 라벨 기반으로 전환. 부분일치(`includes`)라 짧은 검색은 양쪽 매칭되나, `여자`·`고등학교` 등 제거된 토막 글자 검색은 결과 달라짐.

| 입력 | old (raw, 삭제됨) | new (shared studentSearchTerms) |
|------|------|------|
| 진명여자고등학교 고1 | `["진명여자고등학교","진명여자고등학교고","진명여자고등학교고1"]` | `["진명여","진명여고","진명여고1"]` |
| 서울봉영여자중학교 중1 | `["서울봉영여자중학교","서울봉영여자중학교중","서울봉영여자중학교중1"]` | `["서울봉영여","서울봉영여중","서울봉영여중1"]` |
| 서울대일고등학교 (졸업+1) | `["서울대일고등학교","…고","…고4"]` | `["서울대일","서울대일고","서울대일고(졸업+1)"]` |
| (학교 미입력) 중2 | `[]` | `["중2"]` (학부+학년 검색 가능 — 개선) |
| 신목 중2 / 서초 중2(예외) | `["신목","신목중","신목중2"]` | 동일(무변화) |

→ 이제 **표시 라벨(이미 `studentFullLabel`로 통일됨)과 검색어가 일치**. `진명여자고등학교`로 검색하던 사용자는 `진명여` term에 매칭(부분일치로 `진명`은 양쪽 매칭). QA·공지 권장.

## 빌드 결과

`npx vite build` ✓ 36 modules transformed, built in 12.05s. 에러 없음. (기존 chunk>500kB 경고는 무관·기존.)

## 제약 준수

- 커밋·푸시·배포 **안 함**(검토 대기). shared repo **무수정**(이미 push된 v1.16.0 소비만).
