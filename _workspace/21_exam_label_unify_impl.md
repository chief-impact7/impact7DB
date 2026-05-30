# 21. exam 학교 라벨 → @impact7/shared 통일 — 구현 내역

작성: 2026-05-30 · 범위: impact7exam 앱 (TypeScript, Next.js 16) · 상태: **구현 완료(커밋 전)**
근거 계획: `_workspace/19_exam_label_unify_spec.md` (Phase 0~4) · DSC 선례: `_workspace/20_dsc_label_unify_impl.md`

전역 전환 sub-project의 exam 부분. exam 표시·검색 라벨을 DB·DSC와 **완전히 동일한**
`@impact7/shared/student-label`(v1.15.0) 예측 학부 기준으로 통일. 비졸업 분기·예외 없음.
ExternalScorePanel·시험분석·외부성적표 자체 도메인은 **손대지 않음**(경계 엄수).

---

## 1. Phase 0 — 데이터 전제 확인 (통과)

같은 `students` 컬렉션(`impact7db`) 재원 학생 샘플 15건 점검:
- `school_elementary/middle/high` 3필드 중 1개 이상 존재 + 현재 level과 일치: **15/15**
- DB가 15,032건 전수 백필했으므로 `studentFullLabel`이 학교를 정상 표시. 진행 OK.

---

## 2. 변경 파일 목록 (5)

| 파일 | 변경 |
|------|------|
| `package.json` | `@impact7/shared` `github:chief-impact7/impact7-shared#v1.15.0` 추가 (DB·DSC 동일 태그) |
| `package-lock.json` | shared resolved commit 기록 (npm install) |
| `src/shared/types/impact7-shared.d.ts` | **신규** — shared `student-label` 로컬 ambient 타입 선언 (shared repo 무수정) |
| `src/shared/types/student.ts` | `Student`에 `school_elementary?/school_middle?/school_high?: string` 추가 |
| `src/shared/lib/student-display.ts` | `formatSchoolShort`·`schoolSearchTerms`를 shared `studentFullLabel` 기반으로 재작성 |
| `src/app/(dashboard)/students/page.tsx` | 검색 values 배열에서 구 `student.school` 단일 미러 직접 참조 제거 (예측 기준 검색어로 일임) |

소비처 import 경로·함수 시그니처는 **무변경**:
- 표시 #1 `students/page.tsx:143,412` `formatSchoolShort(student)` — 그대로 동작.
- 표시 #3 `server/growth-report/data.ts:111` `formatSchoolShort(enrolledRaw)` — 그대로 동작.
- 검색 #2 `students/page.tsx:292` `schoolSearchTerms(student)` — 그대로 동작.

---

## 3. Phase 1 — 인프라 (타입 보강 방식)

### TS 타입 보강 — 로컬 ambient .d.ts (권장안 채택)
shared `student-label.js`는 순수 JS·.d.ts 없음. **shared repo는 SSoT/버전 충돌 회피로 무수정**
(태스크 제약). exam 로컬에 `src/shared/types/impact7-shared.d.ts`로
`declare module "@impact7/shared/student-label"`를 작성, v1.15.0 export 시그니처
(`studentFullLabel`/`currentSchool`/`normalizeRealLevelGrade`/`SCHOOL_FIELD`)와 일치시킴.
`moduleResolution: "bundler"` + ambient module declaration으로 타입 정상 해석(implicit any 0).

### Student 타입 확장
`school_elementary?/school_middle?/school_high?: string` 추가. `studentFullLabel`이
의존하는 학부별 필드. `growth-report/data.ts`의 `enrolledRaw`(Student 확장)에도 자동 포함.

---

## 4. Phase 2 — 표시 라벨 전환

`formatSchoolShort`를 shared `studentFullLabel` 래퍼로 교체(DSC가 `studentShortLabel`에서 쓴 패턴):

```ts
import { studentFullLabel } from "@impact7/shared/student-label";
export function formatSchoolShort(student) {
  return studentFullLabel(student);  // 입력: school_*/level/grade
}
```

구 로직(`student.school` 단일 미러 + level 약자 합성)에서 예측 학부 필드 기반으로 전환.
졸업 `고(졸업+N)`·연 진급·학교명 정규화 전부 수용. 표시 #1·#3 동시 통일.

---

## 5. Phase 3 — 검색어 전환 (exam 로컬, shared 신설 보류)

`schoolSearchTerms`를 shared `studentFullLabel`/`normalizeRealLevelGrade` 기반으로 재작성.
**DSC와 동일 패턴**: 가장 구체적 term은 `studentFullLabel` 자체(정규화 표시와 100% 일치),
상위 두 단계는 full에서 학년/졸업 꼬리를 정규식으로 떼어 `[학교, 학교+학부, 풀라벨]` 복원.
shared `studentSearchTerms` 신설은 **보류**(spec 지시 — exam 로컬 후 후속 공통화).

검색-표시 기준 입력 일치(예측 학부 학교 + 예측 학년)로 R4 해소, 다단계 부분일치 UX 유지(R3 완화).

### exam 고유 보정 — 학교 없을 때 노이즈 제거
학교명이 비면(`school===""`) 중간 단계가 학부글자 단독(`"중"`)이 되어 검색 노이즈가 됨.
이 경우 `[full]`만 반환(`if(!school) return [full]`)하도록 보정 → DSC 표(학교없음 중2 → `["중2"]`)와 일치.

검증(대표 케이스, 모두 표시 라벨 부분일치 성공):

| 입력 | full(표시) | terms |
|------|-----------|-------|
| 신목 중2 | `신목중2` | `[신목, 신목중, 신목중2]` |
| 진명여자고등학교 고1 | `진명여고1` | `[진명여, 진명여고, 진명여고1]` |
| 윤중 중1 (DUP예외) | `윤중중1` | `[윤중, 윤중중, 윤중중1]` |
| 대일 고졸+1 | `대일고(졸업+1)` | `[대일, 대일고, 대일고(졸업+1)]` |
| 서울염경중학교 중1 (정규화) | `서울염경중1` | `[서울염경, 서울염경중, 서울염경중1]` |
| 학교없음 중2 | `중2` | `[중2]` |

---

## 6. Phase 4 — 경계 엄수 (비대상 무수정 확인)

`formatSchoolShort`/`schoolSearchTerms` 소비처 grep 결과 = 정확히 #1(students/page) + #3(growth-report/data) 둘뿐.

- **#6 ExternalScorePanel — 무수정.** `formatSchoolShort` 미import. 학교명 동등성 비교용
  `isSameSchoolName`/`canonicalSchoolName`/`schoolMatchKey`는 student-display.ts에 **그대로 유지** →
  ExternalScorePanel·useExternalScores가 변함없이 사용. 외부성적표 매칭 무영향.
- **#7~#10 ExamAnalysis·ExternalScoreEvent 자체 `school` 필드 — 무수정.** `.school` 일괄 치환 안 함.
  students 컬렉션 소비처만 정확히 골라 전환. 시험분석·외부성적표 도메인 무결성 유지.

---

## 7. old(formatSchoolShort 구) vs new(studentFullLabel) diff

같은 `students` 컬렉션 실데이터로 두 로직 비교:

- **재원(활성) 349건: 변동 0건 (0.0%)** — old==new 완전 동일. (DSC와 동일하게 활성 학생 무변동)
- 전체 4000건 표본: 변동 3484건(87.1%) — **거의 전부 퇴원 학생의 옛 데이터**.
  grade에 졸업 후 누적 학년(7/13 등)이 저장돼 있어 진급/졸업 환산이 작동한 결과.

변동 분류 예시:

| 분류 | 데이터 | old | new |
|------|--------|-----|-----|
| 졸업 | 고등 grade5 강서(h) | `강서고5` | `강서고(졸업+2)` |
| 졸업(누적overflow) | 중등 grade7 목일(m) | `목일중7` | `고(졸업+1)` |
| 정규화 | 중등 grade1 서울염경중학교(m) | `서울염경중학교중1` | `서울염경중1` |
| 진급 | 중등 grade4 신서(m) | `신서중4` | `고1` |
| DUP예외 | 중등 grade4 윤중(m) | `윤중중4` | `고1` (누적 진급으로 고1) |
| 학교없음 | 초등 grade5 school="" | `""` | `초5` |

**해석:** 변동은 (1) 예측 학부·진급(grade 누적 환산), (2) 졸업 `고(졸업+N)`, (3) 학교명 정규화,
(4) 학교 누락 시 학부+학년 산출에서 발생. R2(성적표 PDF 표시값 변경)는 사용자 확정 수용.
활성 학생 무변동이므로 실운영 성적표 영향은 사실상 졸업·진급 시즌 전환분에 한정.

---

## 8. 검증 결과

- `npx tsc --noEmit`: **통과** (에러 0, implicit any 0).
- `npm run build` (next build): **Compiled successfully** (에러·린트 경고 0).
- 경계 grep: `formatSchoolShort`/`schoolSearchTerms` 소비처 #1·#3만, 매칭 헬퍼 무변경.
- 검색어 대표 6케이스 표시 라벨 부분일치 전부 성공.
- 커밋·푸시 미수행(오케스트레이터 조율 대기). simplify/review는 커밋 전 단계에서 처리.

---

## 9. 후속/인계 사항

- 검색어 `schoolSearchTerms`는 현재 exam·DSC 모두 **로컬 구현**. 후속으로 shared
  `studentSearchTerms`(v1.16.0) 승격 시 양 앱 로컬 로직 제거 가능(DRY).
- exam은 아직 `.school` 단일 미러를 ExternalScorePanel 매칭(`isSameSchoolName`)에서 사용.
  전역 미러 제거(전환 최종 단계)는 매칭 로직을 학부별 필드 기반으로 옮긴 뒤에만 가능 — 일정 조율 필요.
