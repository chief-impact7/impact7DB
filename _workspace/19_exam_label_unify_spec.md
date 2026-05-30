# 19. exam 학교 라벨 통일 분석/계획 (`formatSchoolShort`/`schoolSearchTerms` → `@impact7/shared`)

작성일: 2026-05-30 / 상태: 분석·계획 전용 (코드 미수정)
대상 앱: impact7exam (TypeScript, Next.js 16 App Router)
shared: `@impact7/shared@1.15.0` → `student-label` (`studentFullLabel`, `currentSchool`, `SCHOOL_FIELD`)

---

## 0. 핵심 결론 (요약)

1. **전환 진입점은 단 2개 파일·2개 함수다.** exam의 `formatSchoolShort` 실소비처는 `students/page.tsx`(목록·검색)와 `server/growth-report/data.ts`(성적표 메타) 두 곳뿐. `schoolSearchTerms`는 `students/page.tsx` 검색 1곳. 메모리의 "29곳"은 과거 카운트로 보이며, **현재 코드 기준 students 컬렉션 소비 진입점은 사실상 3개소(중복 제거 시 2개 함수·2개 파일)** 다.
2. **나머지 .school 참조(현재 총 36곳 중 대부분)는 exam 자체 도메인** — `ExamAnalysis`(시험분석)와 `ExternalScoreEvent`(외부성적표 이벤트)의 자체 `school` 필드. students 컬렉션과 무관하므로 **전환 대상 아님.**
3. **현재 exam은 `@impact7/shared`를 의존성·import·node_modules 어디에도 갖고 있지 않다.** 전환하려면 먼저 패키지 추가가 선행돼야 한다(인프라 작업).
4. **경계 교차점이 1곳 존재: `ExternalScorePanel`.** students 컬렉션(`useStudents`)을 읽으면서 그 `.school`을 외부성적표 이벤트(자체 도메인)의 학교와 `isSameSchoolName`으로 매칭한다. 이 지점은 students 소비이지만 `formatSchoolShort` 미경유 — **별도 판단 필요.**
5. **의미 차이 주의: `formatSchoolShort`는 "students에 저장된 현재 .school 미러 + level + grade"의 단순 합성**이고, **shared `studentFullLabel`은 "예측 학부 기준" + 학교명 정규화 + 졸업 처리**다. 단순 치환이 아니며 출력 형식이 달라진다(예: 졸업생, 진급 반영, 정규화). short 형식("영도초6") 자체는 `studentFullLabel`이 동일 형태로 산출 가능하나 **값이 달라질 수 있다.**

---

## 1. 현재 exam 로직 요약

파일: `src/shared/lib/student-display.ts`

### 1.1 `formatSchoolShort(student: Pick<Student,"school"|"level"|"grade">): string`
- 입력: `student.school`(단일 미러 필드), `student.level`(초등/중등/고등), `student.grade`
- 로직: `school.trim()` → 비면 `""`. `level`을 `{초등:초,중등:중,고등:고}`로 약자화(미매핑은 원문 통과). grade 문자열화.
- 출력: `${school}${levelShort}${grade}` (예 `"영도초6"`). 학교 없으면 `""`. 학년만 누락 시 `"영도초"`.
- **정규화 없음** — `.school`에 저장된 원문 그대로 사용("부산영도초등학교"면 그대로 붙음).
- **예측·진급·졸업 처리 없음** — 저장된 level/grade 스냅샷 그대로.

### 1.2 `schoolSearchTerms(student): string[]`
- 출력: `[school, school+levelShort, school+levelShort+grade]` 중 빈 값 제외.
- 예 `"월촌중"+중등+2 → ["월촌중","월촌중중","월촌중중2"]`.
- 검색 필터에서 `values.some(v => v.includes(query))` 형태로 사용.

### 1.3 그 외 동일 파일의 학교명 헬퍼 (전환과 무관, 외부성적표 매칭 전용)
- `canonicalSchoolName`, `schoolMatchKey`, `isSameSchoolName` — **exam 자체 도메인(외부성적표 이벤트 학교명 매칭)** 전용. shared 전환 대상 아님. (단, shared의 `normalizeSchoolForLabel`과 규칙이 유사하나 별개 — 통합은 본 태스크 범위 밖.)

---

## 2. students 소비처(전환 대상) vs exam 자체 도메인(비대상) 경계 표

| # | 위치 | .school 출처 | formatSchoolShort/Terms 경유 | 분류 | 전환 |
|---|------|------|------|------|------|
| 1 | `app/(dashboard)/students/page.tsx:413,143` | **students 컬렉션** (`useStudents`) | `formatSchoolShort(student)` | students 소비 | ✅ 대상 |
| 2 | `app/(dashboard)/students/page.tsx:288,293` | **students 컬렉션** | `student.school` + `schoolSearchTerms(student)` (검색) | students 소비 | ✅ 대상 |
| 3 | `server/growth-report/data.ts:111` | **students 컬렉션** (`loadEnrolledStudent` → `collection("students")`) | `formatSchoolShort(enrolledRaw)` | students 소비 | ✅ 대상 |
| 4 | `server/growth-report/commentary.ts:57` | `GrowthReportStudent.school` (#3의 **파생값**) | 간접 | 파생 소비 | ⏭ #3 따라감 |
| 5 | `client/components/reports/growth/StudentInfoStrip.tsx:17` | `GrowthReportStudent.school` (#3의 **파생값**) | 간접 | 파생 소비 | ⏭ #3 따라감 |
| 6 | `client/components/results/ExternalScorePanel.tsx:45,144,241,332…` | **students 컬렉션** (`useStudents`) + 이벤트 자체 school | `studentSchool()=student.school` 직접 (미경유), `isSameSchoolName` | **경계 교차** | ⚠ 별도 판단 |
| 7 | `shared/types/external-score.ts` `ExternalScoreEvent.school`/`Student.school` | **exam 자체**(외부성적표 이벤트) | — | 자체 도메인 | ❌ 비대상 |
| 8 | `shared/types/exam-analysis.ts:56` `ExamAnalysis.school` | **exam 자체**(시험분석) | — | 자체 도메인 | ❌ 비대상 |
| 9 | `app/(dashboard)/analyses/page.tsx`, `server/analyses/*`, `client/components/analyses/*`, `app/api/analyses/[id]/pdf/route.ts` | **exam 자체**(`ExamAnalysis`) | — | 자체 도메인 | ❌ 비대상 |
| 10 | `shared/lib/analyses/status.ts:19` | `ExamAnalysis.school` | — | 자체 도메인 | ❌ 비대상 |

### 경계 판정 근거
- **students 컬렉션 소비 = `useStudents()`(클라) 또는 `db.collection("students")`(서버)로 읽은 Student 객체의 `.school`.** → #1,#2,#3,#6.
- **exam 자체 도메인 = `ExamAnalysis`/`ExternalScoreEvent`가 자체적으로 가진 `school` 입력 필드**(시험지·외부성적표 메타데이터로 사용자가 입력). students 마스터와 무관. → #7~#10. **전환하면 시험분석/외부성적표 데이터가 깨진다.**
- **#6 (ExternalScorePanel) 이 경계의 핵심 모호점:** students의 `.school`을 읽지만 `formatSchoolShort`를 거치지 않고 **원문 그대로** 외부성적표 이벤트 학교(`event.school`)와 `isSameSchoolName`으로 매칭/필터/정렬한다. 라벨 표시가 아니라 **학교명 동등성 비교**가 목적이므로, 여기는 `studentFullLabel`(예측 학부·졸업 라벨)로 바꾸면 매칭이 깨진다. → 전환 대상이 아니며, 굳이 통일한다면 `currentSchool(student)`(현재 학부 원문) 정도가 후보지 정규화 비교(`isSameSchoolName`)와는 별개 트랙.

---

## 3. shared와의 의미/형식 차이 표

| 항목 | exam `formatSchoolShort` | shared `studentFullLabel` | 영향 |
|------|--------------------------|---------------------------|------|
| 학교 출처 | `student.school` (단일 미러) | `student[SCHOOL_FIELD[예측학부]]` (3필드 중 예측 학부 것) | 미러가 곧 현재학부면 대개 일치. 단 **예측 학부 ≠ 현재 학부**일 때(진급/졸업 시즌) 다름 |
| 학부 기준 | 저장된 `level` 스냅샷 | **예측 학부**(매년 진급 반영) | 진급 직후 라벨이 한 학년/학부 앞서감 |
| 졸업 처리 | 없음 (저장값 그대로) | `"고N(졸업+M)"` 형태로 표기 | 졸업생 표시가 달라짐 |
| 학교명 정규화 | 없음 (원문) | `normalizeSchoolForLabel`: "…고등학교"→"…", 지역 prefix 제거, 약어(여자→여 등) | 출력 문자열이 짧아짐 → **검색어/표시 모두 변동** |
| 학부글자 중복 제거 | 없음 (`월촌중`+중→`월촌중중`) | `endsWith(lv)`면 제거 (`월촌중`→`월촌중2`), DUP_EXCEPT 예외 | 검색 인덱스(`schoolSearchTerms`)와 충돌 |
| grade 누락 | `"영도초"` | `"영도초"` (grade 0 → 빈) | 유사 |
| 학교 없음 | `""` | `""` (정규화 결과 빈) + 학부글자/학년만 가능 | shared는 학교 없어도 `"고2"` 등 산출 가능(차이) |
| 형식(short) | `학교+학부약자+학년` | `학교(정규화)+학부약자+학년` | **형식은 동형, 값은 정규화·예측으로 상이** |

**검색(`schoolSearchTerms`) 관점:** shared에는 검색어 배열을 주는 함수가 없다. `studentFullLabel` 하나로 대체하면 `["월촌중","월촌중중","월촌중중2"]` 같은 다단계 부분일치 후보가 사라진다. 검색 UX 저하 우려 → 전환 시 검색어 생성기를 exam 측에 별도 유지하거나 shared에 `studentSearchTerms` 신설 필요.

---

## 4. import / TS 호환성

| 점검 | 결과 |
|------|------|
| exam이 `@impact7/shared` 의존? | **아니오** (`package.json`에 없음, `node_modules`에 미설치, 코드 import 0) |
| shared 패키지 형식 | ESM (`"type":"module"`), `exports` 서브패스 `./student-label` 제공, `github:chief-impact7/impact7-shared#v1.15.0` |
| exam moduleResolution | `"bundler"` → ESM·exports map 해석 가능. import 자체는 문제없음 |
| shared 타입 정의 | `student-label.js`는 **순수 JS, .d.ts 없음**. exam은 TS strict 추정 → `studentFullLabel(student)` 호출 시 **타입 미제공**(implicit any) 문제. `allowJs`/`@ts-ignore`/로컬 선언 보강 또는 shared에 .d.ts 추가 필요 |
| SCHOOL_FIELD 필드 존재 | exam `Student` 타입엔 `school_elementary/middle/high` **없음**. exam students 데이터에 해당 3필드가 실제 채워져 있는지 **런타임 확인 필요**(currentSchool/studentFullLabel은 이 3필드에 의존). 없으면 라벨이 빈 학교로 나옴 |

**결론:** 인프라(패키지 추가) + 타입(.d.ts 또는 로컬 선언) + 데이터(3필드 존재) 3가지 선행 조건이 모두 충족돼야 안전 전환 가능. 현재 어느 것도 충족 안 됨.

---

## 5. 전환 가능 여부 + 리스크

**가능하나 "단순 치환 불가", 선행조건 3건 + 의미변경 수용 전제.**

리스크:
- **R1 (데이터):** exam students 문서에 `school_elementary/middle/high`가 비어 있으면 `studentFullLabel`이 학교 없는 라벨을 산출 → 성적표·목록에서 학교 누락. (현재 exam은 `.school` 미러만 신뢰) — **가장 큰 리스크.**
- **R2 (의미):** 예측 학부·정규화·졸업 표기로 **표시 라벨 값이 바뀜.** 성적표/PDF(`growth-report`)에 찍히는 학교 문자열이 과거 발행분과 달라질 수 있음. 학부모 대면 문서라 변경 가시성 높음.
- **R3 (검색):** `schoolSearchTerms`의 다단계 부분일치가 사라지면 학생 검색 hit율 저하. shared에 대응 함수 없음.
- **R4 (경계오염):** #6 ExternalScorePanel·#7~#10 자체 도메인을 실수로 함께 치환하면 **외부성적표 매칭·시험분석 데이터 무결성 파손.** `.school` grep 일괄 치환 절대 금지.
- **R5 (타입):** .d.ts 부재로 빌드 타입에러 또는 any 누수.

---

## 6. 단계별 전환 계획 (코드 미수정, 권고안)

**Phase 0 — 선행 검증 (코드 변경 없음)**
- exam students 컬렉션 샘플에서 `school_elementary/middle/high` 채워짐 여부 확인. 비어 있으면 전환 보류(DB 측 백필 의존).
- `growth-report` PDF 라벨 변경이 업무상 허용되는지 사용자 확인(R2).

**Phase 1 — 인프라**
- exam `package.json`에 `@impact7/shared` 추가(DB와 동일 태그 `#v1.15.0`), 설치.
- shared에 `student-label.d.ts` 동반 or exam에 로컬 `.d.ts` 선언(`studentFullLabel`,`currentSchool`,`SCHOOL_FIELD`). (R5)
- exam `Student` 타입에 `school_elementary?/school_middle?/school_high?` 추가.

**Phase 2 — 표시 라벨만 우선 전환 (좁은 범위)**
- `students/page.tsx` 목록 표시(#1)와 `growth-report/data.ts`(#3)의 `formatSchoolShort` → `studentFullLabel`로 교체.
- 단, **검색(#2 `schoolSearchTerms`)은 이 단계에서 건드리지 않음.** 표시와 검색을 분리해 리스크 격리.
- 시각 회귀 확인(목록·성적표 PDF 샘플).

**Phase 3 — 검색 전환 (별도)**
- shared에 `studentSearchTerms`(또는 `currentSchool` 기반 후보 생성) 신설 후 #2 교체, 또는 exam `schoolSearchTerms`를 `currentSchool` 입력으로만 재배선.
- 검색 hit 회귀 테스트.

**Phase 4 — 경계 교차점(#6) 판단**
- ExternalScorePanel은 **전환하지 않는 것을 기본값으로** 권고. 통일이 필요하면 표시용만 `currentSchool`로, 매칭(`isSameSchoolName`)은 현행 유지.

**비대상 고정:** #7~#10(`ExamAnalysis`·`ExternalScoreEvent` 자체 school)은 **전 단계에서 손대지 않음.** 자체 도메인 입력 필드이므로 통일 범위 밖.

---

## 7. 후속/오케스트레이터 인계 사항
- 본 전환은 DB의 "전역 전환" 중 exam 슬라이스. **선행으로 DB 측 students에 학부별 3필드 백필이 exam이 읽는 동일 컬렉션에 반영돼 있어야** Phase 2가 안전(R1). exam은 `students`를 읽기 전용으로만 쓰므로 백필 주체는 DB.
- 단일 `.school` 미러 제거(전역 전환 최종 단계)는 exam의 #6·#1~#3가 모두 3필드/shared로 이전된 뒤에만 가능. 현재 exam은 미러 의존도가 남아 있어 **미러 제거 시 exam이 깨진다** — 제거 일정 조율 필요.
