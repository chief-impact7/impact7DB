# 18. DSC 학교 라벨 → @impact7/shared 통일 — 정밀 분석 & 전환 계획

작성: 2026-05-30 · 범위: impact7newDSC 앱 · **분석 전용(코드 미수정)**

전역 전환(sub-project) 중 DSC 부분. DB는 이미 `@impact7/shared/student-label`(v1.15.0)의
`currentSchool`/`studentFullLabel`로 라벨을 통일했다. DSC도 통일 가능한지, 의미·형식 차이가
무엇인지, 안전한 단계 전환 계획을 정리한다.

---

## 1. 현재 DSC 로직 요약

### 1-1. `studentShortLabel(s)` — 표시 라벨 SSoT
- 위치: `src/shared/firestore-helpers.js:290`
- 시그니처: `studentShortLabel(s) -> string`
- 입력: `s.school`(단일 미러 필드), `s.level`('초등'|'중등'|'고등'), `s.grade`
- 로직:
  1. `s.school`에서 `여자→여` 1회 치환
  2. `level` → 학부글자(초/중/고)
  3. 학교명 접미어 축약: `초등학교$→초`, `중학교$→중`, `고등학교$→고` (정규식, **끝에만**)
  4. 학교명이 학부글자로 끝나면 중복 방지(suffix 생략), 아니면 학부글자 붙임
  5. `학교 + suffix + grade` 반환
- 출력 예: (신목,중등,2)→`신목중2`, (진명여자고등학교,고등,1)→`진명여고1`, (윤중,초등,6)→`윤중초6`
- **school 없으면 빈 문자열 반환**

### 1-2. `school-normalizer.js` — 정규화 + 검색어
- 위치: `school-normalizer.js` (루트)
- export: `cleanSchoolName`, `levelShortName`, `collectKnownSchoolNames`,
  `normalizeStudentSchools`, `normalizeSchoolName`, `schoolSearchTerms`
- 핵심:
  - `normalizeSchoolName(school, level, knownSchools)` — `LEVEL_SUFFIXES` 테이블로 접미어 제거.
    `safe:true`(초등학교/초등/초교 등)는 무조건 제거, `safe:false`(단일 '초'/'중'/'고')는
    `knownSchools`에 base가 있을 때만 제거. **정규화는 학교명 base 추출(축약 라벨용 아님)**.
  - `schoolSearchTerms(s)` — 검색 인덱스용. `[school, school+levelShort, school+levelShort+grade]`
    배열 반환. 예: (신목,중등,2)→`['신목','신목중','신목중2']`.
  - `normalizeStudentSchools` / `collectKnownSchoolNames` — **현재 호출처 0건 (dead code)**.
    `normalizeStudentSchools`는 `student.school`을 mutate하나 아무도 부르지 않음.

---

## 2. 소비처 전수 목록

### 2-1. `studentShortLabel` 소비처 (표시) — 8곳
| 파일 | 라인 | 용도 |
|------|------|------|
| `past-search.js` | 60 | 퇴원생 검색 결과 서브라벨 |
| `class-student-search.js` | 47 | 학생 검색 결과 meta |
| `visit-list-render.js` | 64 | 방문 리스트 detail |
| `naesin.js` | 269, 667 | 내신/특강 프로필 태그 |
| `class-setup.js` | 113, 891, 972 | 반편성 shortLabel·검색결과·meta |
| `hw-management.js` | 753 | 숙제관리 태그 |
| `daily-ops.js` | 2313 | 일일운영 desc tail |
| `src/dashboard/components/DailyLogBoard.jsx` | 254, 338 | 대시보드 meta(React) |

→ 표시 경로는 **전부 `studentShortLabel` 단일 경유**. 직접 `.school` 문자열 조립 표시 없음.

### 2-2. `schoolSearchTerms` 소비처 (검색) — 4곳
| 파일 | 라인 | 용도 |
|------|------|------|
| `class-student-search.js` | 72 | 검색어 매칭 |
| `role-memo.js` | 362 | 역할 메모 검색 |
| `class-setup.js` | 870 | 반편성 검색 |
| `leave-request.js` | 584 | 휴퇴원 요청 검색 |

### 2-3. 직접 `.school` 소비 / 3-필드 모델
- DSC 소스 전체에서 `school_high`/`school_middle`/`school_elementary`/`currentSchool`/
  `studentFullLabel` 참조 **0건**.
- DSC는 학생을 `students` 컬렉션에서 읽기 전용으로 로드(`data-layer.js:loadStudents`),
  **school 관련 가공 없음**. 즉 DSC가 보는 `s.school`은 DB가 써준 "현재 학부 미러" 그대로.
- `s.level`/`s.grade`도 마스터의 **현재 학년**(연 진급 미반영 원본).

---

## 3. shared(v1.15.0) vs DSC 의미·형식 차이

### 3-1. 기준(학교·학년) 의미 차이 — **가장 중요**
| 항목 | DSC `studentShortLabel` | shared `studentFullLabel` |
|------|------------------------|---------------------------|
| 학교 출처 | `s.school`(현재 학부 미러, 단일) | `s[school_*]`(예측 학부 필드) |
| 학년 기준 | `s.grade` 원본(현재) | `normalizeRealLevelGrade`로 **연 진급 반영** |
| 졸업 처리 | 없음(고3까지) | `고(졸업+N)` 라벨 생성 |
| 학교 미입력 | **빈 문자열 반환** | 학교 없이 `고1`/`고(졸업+6)` 반환 |

→ DSC는 "지금 다니는 학교·학년"을, shared는 "예측 학부 기준(매년 진급·졸업 반영)"을 표시.
   값이 같은 학생도 있으나 **학년 진급기·졸업생에서 라벨이 달라짐**.

### 3-2. 정규화 규칙 차이
| 규칙 | DSC | shared |
|------|-----|--------|
| 접미어 제거 | `초등학교/중학교/고등학교$`만 | `(초등학교\|중학교\|고등학교\|학교)$` (일반 '학교'도) |
| 약어 | `여자→여`만 | `사범대부속→사대부, 여자→여, 외국어→외, 부속→부` |
| 지역 prefix | 없음 | 광역시/도 17개 prefix 제거(조건부) |
| 중복글자 예외 | 없음(무조건 중복방지) | `DUP_EXCEPT`(서초·윤중·안중 등 18개)는 학부글자 유지 |
| 공백 정규화 | 없음 | `\s+→' '` |

→ shared가 더 적극적으로 축약·예외 처리. 같은 입력도 출력이 달라질 수 있음
   (예: '서울대사대부고' DSC=`서울대사대부고N` vs shared=`사대부고N`; '윤중초6'는 둘 다 `윤중초6`).

### 3-3. short vs full 형식 — **대응 가능**
- 이름은 다르나(DSC=Short, shared=Full) **출력 토큰 구조는 동일**: `학교+학부글자+학년`.
- shared에 별도 short 변형 없음. `studentFullLabel` 하나가 DSC short와 같은 자리에 들어감.
- 차이는 졸업/축약/예측 기준이지 "길이 형식"이 아님 → **형식 호환 OK**.

---

## 4. import 현황 / 전환 가능 여부

### 4-1. DSC의 @impact7/shared 사용
- `package.json`: `"@impact7/shared": "github:chief-impact7/impact7-shared#v1.12.0"` (**v1.12.0**)
- 이미 import 중: `history`, `enrollment-derivation`, `enrollment-status`, `promote-enroll`,
  `student-number`.
- **`student-label`은 v1.12.0에 없음**(DB의 v1.15.0에만 존재). → **버전 bump 선행 필수.**

### 4-2. 판정
- **전환 가능. 단 전제·검증 2개가 필요:**
  1. **데이터 전제**: DSC 학생 docs에 `school_elementary/middle/high` 3-필드가 채워져 있어야
     `studentFullLabel`이 학교를 표시. DB 전역 전환이 students에 3-필드를 백필했는지 확인 필요.
     (미백필이면 학교 빠지고 `중2`처럼만 나옴 → 표시 깨짐)
  2. **의미 합의**: DSC 표시를 "예측 학부 기준"으로 바꾸는 게 의도와 맞는지 사용자 확인.
     출결/숙제는 보통 "지금" 학년을 보므로, 진급/졸업 표시 변화가 운영상 OK인지 결정 필요.

---

## 5. 리스크

| # | 리스크 | 영향 | 완화 |
|---|--------|------|------|
| R1 | 3-필드 미백필 시 학교 사라짐 | 표시 깨짐(전 8곳) | 전환 전 DB 백필 확인 + 샘플 검증 |
| R2 | 졸업/진급 라벨 변화 | `고3`→`고(졸업+1)` 등 운영 혼란 | 사용자 합의, 필요시 DSC는 비졸업만 |
| R3 | 정규화 규칙 차이로 기존 라벨 변동 | 검색·시각 불일치 | before/after diff 전수 비교 스크립트 |
| R4 | `schoolSearchTerms`가 여전히 `s.school` 기반 | 표시(shared)와 검색(legacy) term 불일치 | 검색도 `currentSchool` 기반으로 동시 전환 |
| R5 | 정렬은 `name` 기준이라 라벨과 무관 | 영향 없음 | — |
| R6 | v1.12→v1.15 bump 시 타 shared 모듈 거동 변화 | 회귀 가능 | changelog 확인 + 빌드/스모크 |

---

## 6. 단계별 전환 계획 (구현은 다음 단계)

**Phase 0 — 전제 확인 (비코드)**
- DB students에 `school_*` 3-필드 백필 완료 여부 확인(특히 DSC가 읽는 활성 status 집합).
- "예측 학부 기준 표시" 의미 변경 사용자 합의.

**Phase 1 — shared 버전 bump**
- `package.json` `@impact7/shared`를 `#v1.15.0`(student-label 포함 버전)으로 올리고 `npm install`.
- 기존 import(history 등) 회귀 없는지 빌드 확인.

**Phase 2 — 표시 라벨 전환**
- `src/shared/firestore-helpers.js`의 `studentShortLabel`를 shared 재노출 래퍼로:
  `import { studentFullLabel } from '@impact7/shared/student-label'` →
  `export const studentShortLabel = studentFullLabel;` (소비처 8곳 import 경로 무변경 → 변경 최소화).
- 졸업생 제외가 필요하면 얇은 래퍼에서 분기(합의 결과 반영).

**Phase 3 — 검색어 전환**
- `school-normalizer.js`의 `schoolSearchTerms`를 `currentSchool(s)` + 예측 학년 기반으로 재작성
  (또는 shared가 search-terms를 제공하면 그쪽으로 이관). 표시/검색 기준 일치.
- dead code(`normalizeStudentSchools`, `collectKnownSchoolNames`, `normalizeSchoolName`) 제거 검토.

**Phase 4 — 검증·정리**
- 활성 학생 전수로 old vs new 라벨 diff 생성, R3 변동 케이스 사용자 검토.
- 빌드(Vite 5174) + 8개 소비처 화면 스모크.
- 차이 없으면 `school-normalizer.js` 슬림화/삭제, `studentShortLabel` 명칭 정리(선택).

---

## 7. 부가 발견
- `normalizeStudentSchools`/`normalizeSchoolName`/`collectKnownSchoolNames`는 **호출처 0건**.
  전환과 무관하게 dead code 정리 후보.
- DSC는 `students` 읽기 전용 — school 가공/쓰기 없음. 전환은 표시·검색 로직만 건드림(안전).
