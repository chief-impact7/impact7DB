# 영향 분석: 검색어 `schoolSearchTerms` → shared `studentSearchTerms` 공통화

분석/계획 전용. 코드 미수정.

---

## 1. 3앱 로컬 구현 정확 비교

### 사용처 (Grep 확인)
| 앱 | 정의 | 호출처 | 호출 형태 |
|----|------|--------|----------|
| DB | `school-normalizer.js:60` | `app.js:842`(과거학생검색), `app.js:1209`(필터검색) | `schoolSearchTerms(s).some(v => v.toLowerCase().includes(term))` |
| DSC | `school-normalizer.js:8` | `class-student-search.js:72`, `role-memo.js:362`, `leave-request.js:584`, `class-setup.js:870` | `.map(t=>t.toLowerCase())` 또는 `.some(...includes)` |
| exam | `src/shared/lib/student-display.ts:45` | `students/page.tsx:292` | `...schoolSearchTerms(student)` (spread) |

→ 모든 callsite가 **문자열 배열을 받아 부분일치(lowercase includes) 또는 spread**로만 소비. 출력 배열 형태가 동일하면 callsite는 무수정 호환.

### 실측 출력 비교 (shared v1.15.0 기준, 동일 입력으로 3구현 실행)
| 입력 | DB | DSC | exam |
|------|----|----|------|
| 신목 중2 | `["신목","신목중","신목중2"]` | 동일 | 동일 |
| 진명여자고등학교 고1 | **`["진명여자고등학교","진명여자고등학교고","진명여자고등학교고1"]`** | `["진명여","진명여고","진명여고1"]` | `["진명여","진명여고","진명여고1"]` |
| 서울대일고등학교 고졸+1 | **`["서울대일고등학교", …"고4"]`** | `["서울대일","서울대일고","서울대일고(졸업+1)"]` | 동일(DSC) |
| 빈 학교 중2 | **`[]`** | `["중2"]` | `["중2"]` |
| 서울봉영여자중학교 중1 | **`["서울봉영여자중학교",…]`** | `["서울봉영여","서울봉영여중","서울봉영여중1"]` | 동일(DSC) |
| 서초 중2 (DUP_EXCEPT) | `["서초","서초중","서초중2"]` | 동일 | 동일 |

### 결론: 세 구현은 동일 출력이 아니다
- **DB는 학교명 정규화·예측학부·졸업표현을 전혀 적용 안 함.** `currentSchool(s)`(현재학부 raw 학교명)에 `levelShortName(s.level)`+숫자만 단순 합성. → `진명여자고등학교`, `서울봉영여자중학교` 같은 **풀네임/지역prefix가 그대로 검색어**가 됨. 졸업생도 `고4`처럼 표시됨.
- **DSC·exam은 `studentFullLabel`(shared) 기반** — 학교명 정규화(`학교`접미 제거, `여자→여`, 지역prefix 제거, 예외14), 예측학부, 졸업 `(졸업+N)`을 적용. 두 앱은 **출력 완전 동일**(검증된 모든 케이스).
- DSC vs exam 코드 차이는 출력에 영향 없음:
  - 빈 학교: DSC `[full].filter(Boolean)`, exam `[full]` → 동일 결과.
  - 중복제거: exam만 `Array.from(new Set(...))`. school·schoolPlusLevel·full이 겹치는 극단(1글자 학교 등)에서만 차이날 수 있으나 실 데이터 영향 미미.
  - exam은 `student.school` 폴백 없음(학부필드만), DB만 `|| s?.school` 폴백 보유 — DB는 import 임시객체용이라 주석에 명시.

### 정본(canonical) 판정
**DSC·exam의 `studentFullLabel` 기반 동작을 정본으로 채택.** 근거:
- 전역 전환의 목표가 "학교 라벨을 shared `studentFullLabel`로 통일"인데 **DB의 검색어만 통일에서 누락**된 상태(표시 라벨은 `studentLabelSync.js`가 이미 `studentFullLabel`로 백필 중, 그러나 UI 검색은 그것과 무관하게 raw 합성).
- 즉 이 작업은 단순 중복 제거가 아니라 **DB 검색 회귀 수정**을 겸한다.

---

## 2. shared repo 구조 & 함수 설계

### 현재 구조
- repo: `/Users/jongsooyi/projects/impact7-shared` (github:chief-impact7/impact7-shared), 현재 `v1.15.0`.
- `student-label.js` export: `SCHOOL_FIELD`, `currentSchool`, `normalizeRealLevelGrade`, `studentFullLabel`. (`LEVEL_SHORT`는 모듈 내부 비공개 const.)
- `package.json` `exports`/`files`에 `./student-label` 등록 완료.
- exam이 `src/shared/types/impact7-shared.d.ts`로 `@impact7/shared/student-label` ambient 선언 보유(SCHOOL_FIELD/currentSchool/normalizeRealLevelGrade/studentFullLabel만).

### 신설 함수: `studentSearchTerms`
배치: **`student-label.js`에 append**(별도 파일 불필요 — 의존 심볼 `studentFullLabel`/`normalizeRealLevelGrade`/`LEVEL_SHORT`가 전부 이 파일에 있음, 새 export 경로도 불필요).

시그니처:
```js
// student-label.js 끝에 추가
export function studentSearchTerms(student) {
  const full = studentFullLabel(student);
  if (!full) return [];
  const norm = normalizeRealLevelGrade(student);
  const predLevel = norm.graduated ? '고등' : norm.level;
  const lv = LEVEL_SHORT[predLevel] || '';

  // full에서 학년/졸업 꼬리를 떼어 [학교, 학교+학부] 복원
  let schoolPlusLevel = full;
  if (norm.graduated)      schoolPlusLevel = full.replace(/\(졸업\+\d+\)$/, '');
  else if (norm.grade)     schoolPlusLevel = full.endsWith(String(norm.grade))
                             ? full.slice(0, -String(norm.grade).length) : full;

  const school = lv && schoolPlusLevel.endsWith(lv)
    ? schoolPlusLevel.slice(0, -lv.length) : schoolPlusLevel;

  if (!school) return [full];                       // 학교명 없으면 학부글자 단독 term 제외
  return Array.from(new Set([school, schoolPlusLevel, full]));
}
```
→ **exam 구현을 정본으로 그대로 이식**(빈학교 명시 처리 + Set 중복제거 포함, 가장 방어적). DSC와 출력 동일, DB 동작은 정본으로 교정됨.

내부 재사용: `studentFullLabel`(정규화·예측학부·졸업), `normalizeRealLevelGrade`(예측학부/졸업 판정), `LEVEL_SHORT`(모듈 내부 const). `SCHOOL_FIELD`는 직접 불필요(full에서 역산).

### exports/files
`./student-label` 경로 그대로(추가 export만). `package.json` `files`·`exports` **수정 불필요**(같은 파일에 함수만 추가).

---

## 3. 타입 처리 방안

- shared는 순수 JS·`.d.ts` 미동반 정책 유지(repo 손대지 않는 기존 규율).
- **exam 로컬 ambient 선언(`impact7-shared.d.ts`)에 `studentSearchTerms` 1줄 추가**가 최소 침습:
  ```ts
  export function studentSearchTerms(student: {
    level?: string; grade?: string | number; [key: string]: unknown;
  }): string[];
  ```
- DB·DSC는 JS라 타입 불요.
- 대안(shared에 `.d.ts` 신설)은 이번 범위 밖 — exam 로컬 확장으로 충분.

---

## 4. 버전 · 배포 계획

### 버전
- 현재 최신 태그 `v1.15.0`, HEAD = v1.15.0 커밋. → 신규 함수 추가는 **`v1.16.0`** (feedback_shared_version_conflict 규율: 현재 태그 확인 후 다음 번호, MINOR 증가).
- 3앱 `package.json` 의존성을 `#v1.15.0` → `#v1.16.0`으로 bump (DB:28, DSC:13, exam:13행).

### 배포 형태
- shared는 github 의존(`github:chief-impact7/impact7-shared#vX`). 태그 push 후 각 앱 `npm install`로 lock 갱신.
- 각 앱 재빌드·재배포:
  - DB(Vite, GitHub Actions 자동배포) — push 시 자동.
  - DSC(Vite), exam(Next.js) — 각 앱 빌드/배포 파이프라인.

---

## 5. 리스크

| 리스크 | 수준 | 내용 / 완화 |
|--------|------|------------|
| **DB 검색 동작 변경(회귀이자 개선)** | 보통 | DB는 raw 학교명 검색이었음 → 정규화 라벨 검색으로 바뀜. `진명여자고등학교`로 검색하던 사용자는 이제 `진명여` term에 매칭. 부분일치라 `진명`은 양쪽 다 매칭되나, `여자`·`고등학교` 글자 검색은 결과 달라짐. **사실상 표시 라벨과 검색을 일치시키는 의도된 교정** — 사용자 공지 또는 QA 확인 권장. |
| DSC·exam 동작 변화 | 낮음 | 출력 동일 검증됨. 무변화. |
| 빈 학교 처리 변경(DB) | 낮음 | DB는 `[]`였음 → `[full]`("중2" 등). 학교 미입력 학생이 학부+학년으로도 검색 가능해짐(개선). |
| 3앱 동시성 | 없음 | **검색은 앱별 독립**(공유 Firestore 컬렉션의 스키마/데이터 변경 아님, 순수 클라이언트 로직). 앱별 배포 순서 무관. firestore.rules·storage.rules **무관**(읽기 로직만). |
| 로컬 dead code | 낮음 | DB·DSC `school-normalizer.js`의 `schoolSearchTerms`, exam `student-display.ts`의 `schoolSearchTerms` 제거 후 shared 재노출로 교체. DB/DSC `school-normalizer.js`의 다른 export(cleanSchoolName, normalizeSchoolName 등)는 유지 — 파일 통째 삭제 금지. |
| import 임시객체(DB `\|\| s.school` 폴백) | 낮음 | DB의 `school-normalizer.js` 내 import용 임시객체 경로가 `schoolSearchTerms`를 쓰는지 확인 필요(현재 callsite는 app.js 검색 2곳뿐 → 영향 없을 가능성 높음, 교체 시 재확인). |

---

## 6. 단계별 구현 순서

1. **shared**: `student-label.js`에 `studentSearchTerms` 추가(§2 시그니처). `student-label.test.js`에 §1 비교표 케이스(정규화/졸업/빈학교/예외) 추가. `node --test` 통과 확인.
2. **shared 태깅**: commit → `v1.16.0` 태그 → push.
3. **exam**: `package.json` `#v1.16.0` bump → `impact7-shared.d.ts`에 `studentSearchTerms` 타입 1줄 추가 → `student-display.ts`의 로컬 `schoolSearchTerms`를 `export { studentSearchTerms as schoolSearchTerms } from "@impact7/shared/student-label"` 재노출로 교체(또는 callsite를 직접 import로 변경) → 빌드·배포. (exam이 정본이라 동작 무변화 = 가장 안전, 먼저 검증.)
4. **DSC**: `#v1.16.0` bump → `school-normalizer.js`의 `schoolSearchTerms`를 shared 재노출로 교체(다른 export 유지) → 4개 callsite 무수정 확인 → 빌드·배포.
5. **DB**: `#v1.16.0` bump → `school-normalizer.js`의 `schoolSearchTerms`를 shared 재노출로 교체 → app.js 2개 callsite 무수정 확인 → **DB 검색 동작 변경 QA**(정규화 라벨 검색) → 빌드·push(자동배포).
6. dead code·미사용 import 정리, 각 앱 검색 스모크 테스트.

순서 원칙: **무변화 앱(exam→DSC) 먼저, 동작 변경 앱(DB) 마지막**으로 리스크 격리.

---

## 핵심 결론
1. 세 `schoolSearchTerms`는 **동일 출력이 아니다.** DSC·exam은 shared `studentFullLabel` 기반으로 출력 완전 일치하나, **DB만 정규화·예측학부·졸업표현 없이 raw 학교명을 검색어로 합성**한다(`진명여자고등학교…`).
2. 따라서 이 작업은 단순 중복 제거가 아니라 **DB 검색 회귀를 정본(DSC/exam 동작)으로 교정**하는 작업이다. DB 표시 라벨은 이미 `studentFullLabel`로 통일됐지만 UI 검색만 누락돼 있었다.
3. shared `studentSearchTerms`는 **exam 구현을 정본으로 `student-label.js`에 append**(빈학교 명시처리 + Set 중복제거), 내부에서 `studentFullLabel`/`normalizeRealLevelGrade`/`LEVEL_SHORT` 재사용. exports/files·새 경로 수정 불필요.
4. 타입은 **exam 로컬 ambient `.d.ts`에 1줄 추가**로 처리(shared `.d.ts` 신설 불요, repo 무수정 규율 유지).
5. 버전 **v1.16.0**(현재 최신 v1.15.0의 다음 MINOR). 3앱 `#v1.16.0` bump 후 각자 재빌드·배포.
6. **검색은 앱별 독립 순수 클라이언트 로직** — Firestore 스키마/rules 무관, 3앱 동시성·배포 순서 무관. 다만 리스크 격리를 위해 무변화 앱(exam→DSC) 먼저, DB 마지막.
7. 위험도 **보통**: DB 검색 동작이 raw→정규화 라벨로 바뀌는 사용자 체감 변화(의도된 교정)가 유일한 주의점. QA·공지 권장. 로컬 `schoolSearchTerms`만 제거하고 같은 파일의 다른 export는 유지.
