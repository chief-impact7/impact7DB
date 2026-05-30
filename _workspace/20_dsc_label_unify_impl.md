# 20. DSC 학교 라벨 → @impact7/shared 통일 — 구현 내역

작성: 2026-05-30 · 범위: impact7newDSC 앱 · 상태: **구현 완료(커밋 전)**
근거 계획: `_workspace/18_dsc_label_unify_spec.md` (Phase 0~4)

전역 전환 sub-project의 DSC 부분. DSC 표시·검색 라벨을 DB와 **완전히 동일한**
`@impact7/shared/student-label`(v1.15.0) 예측 학부 기준으로 통일했다. 비졸업 분기·예외 없음.

---

## 1. Phase 0 — 데이터 전제 확인 (통과)

활성 학생(`재원/등원예정/실휴원/가휴원/상담`) 408건 전수 점검:
- `school_elementary/middle/high` 3필드 중 1개 이상 존재: **407/408**
- 현재 level 일치 필드(`currentSchool`) 채워짐: **407/408**, currentSchool 빈 활성학생 **0건**

DB가 같은 `students` 컬렉션을 백필했으므로 `studentFullLabel`이 학교를 정상 표시한다. 진행 OK.

---

## 2. 변경 파일 목록 (4)

| 파일 | 변경 |
|------|------|
| `package.json` | `@impact7/shared` `#v1.12.0` → `#v1.15.0` (student-label 포함) |
| `package-lock.json` | shared resolved commit 갱신(09f… → 9df285a, v1.15.0) |
| `src/shared/firestore-helpers.js` | `studentShortLabel` 로컬 구현(22줄) 삭제 → `studentFullLabel` 재노출 래퍼로 교체. `import { studentFullLabel } from '@impact7/shared/student-label'` 추가 |
| `school-normalizer.js` | `schoolSearchTerms`를 shared 예측 학부 기준으로 재작성. dead code 5개 함수 제거(아래 §5) |

소비처 import 경로는 **전부 무변경**:
- 표시 8곳(`studentShortLabel`): past-search/class-student-search/visit-list-render/naesin/class-setup/hw-management/daily-ops/DailyLogBoard.jsx — 동일 이름 재노출로 그대로 동작.
- 검색 4곳(`schoolSearchTerms`): class-student-search/role-memo/class-setup/leave-request — 함수 이름·시그니처 유지.

---

## 3. Phase 2 — 표시 라벨 전환

`firestore-helpers.js`의 `studentShortLabel(s)`(s.school 단일 미러 + s.grade 원본 기반)을
shared `studentFullLabel`(예측 학부 필드 `school_*` + 연 진급 반영 학년 + 졸업 `고(졸업+N)`)
재노출로 교체:

```js
import { studentFullLabel } from '@impact7/shared/student-label';
export const studentShortLabel = studentFullLabel;
```

이로써 DSC 표시 8곳이 DB와 동일 라벨 체계로 통일. 졸업/진급/학교명 정규화 전부 수용.

---

## 4. Phase 3 — 검색어 전환 + 택일 결정

### 택일 결정: **(a) DSC 로컬에서 재작성** (shared 신설 안 함)

`school-normalizer.js`의 `schoolSearchTerms`를 DSC 로컬에서 shared
(`studentFullLabel`/`normalizeRealLevelGrade`/`SCHOOL_FIELD`)를 import해 재작성.
shared에 `studentSearchTerms`를 신설(b)하지 않음.

**이유:**
1. **이번 태스크 = DSC 먼저 완주·검증.** shared 신설(b)은 v1.16.0 태깅 + DSC 재install
   사이클이 추가되고, shared repo 수정은 버전 충돌 규율상 exam 작업과 묶어 처리하는 게
   안전하다(현재 최신 태그 v1.15.0 — 불필요한 bump 회피).
2. **태스크가 명시 허용한 보수적 경로** — "(a) 로컬로 먼저 하고 exam 단계에서 공통화".
   exam이 같은 검색어를 필요로 할 때 이 DSC 로컬 로직을 shared로 승격(v1.16.0)하면 DRY 달성.
3. 로컬에서도 **표시와 검색 기준이 동일 입력**(예측 학부 학교 + 예측 학년)으로 일치 — R4 해소.

### 검색어 설계 (표시 라벨과 100% 일치)

다단계 부분일치 `[학교, 학교+학부, 표시라벨]` 형식 유지. 가장 구체적인 term은
`studentFullLabel` 자체로 두어, 학교명 정규화(여자→여, 학교 접미어 제거, DUP 예외 등)가
표시와 **완전히 동일**하게 적용된다. 상위 두 단계는 full에서 학년/졸업 꼬리를 떼어 복원.

검증(대표 케이스, 모두 표시 라벨 부분일치 성공):

| 입력 | full(표시) | terms |
|------|-----------|-------|
| 신목 중2 | `신목중2` | `[신목, 신목중, 신목중2]` |
| 봉영여 중3 | `봉영여중3` | `[봉영여, 봉영여중, 봉영여중3]` |
| 진명여자고등학교 고1 | `진명여고1` | `[진명여, 진명여고, 진명여고1]` |
| 윤중 초6 (DUP예외) | `윤중초6` | `[윤중, 윤중초, 윤중초6]` |
| 대일 고졸+1 | `대일고(졸업+1)` | `[대일, 대일고, 대일고(졸업+1)]` |
| 학교없음 중2 | `중2` | `[중2]` |

---

## 5. Phase 4 — dead code 정리 + 검증

### dead code 제거 (외부 호출처 0건 확인 후)
`school-normalizer.js`에서 제거: `cleanSchoolName`, `levelShortName`,
`collectKnownSchoolNames`, `normalizeStudentSchools`, `normalizeSchoolName`
+ `LEVEL_SUFFIXES` 테이블. 파일이 63줄 → 27줄로 슬림화, 잔존 참조 grep 0건.

### old(studentShortLabel) vs new(studentFullLabel) diff — 활성 408건

- **라벨 변동: 8건(2.0%)**. 단, **grade가 정상 숫자인 학생의 변동은 0건** —
  즉 400/408은 old==new로 완전 동일.
- 변동 8건은 **전부 grade가 비숫자 표기**(`"중3"`, `"초6"`, `"중 3"`)인 학생(대부분 상담 status):

| 데이터(level grade school) | old | new |
|---|---|---|
| 중등 "중3" 당산중 | `당산중중3` | `당산중` |
| 초등 "초6" 영도초 | `영도초초6` | `영도초` |
| 중등 "중 3" 봉영여자중학교 | `봉영여중중 3` | `봉영여중` |
| 중등 "중2" 양정중 | `양정중중2` | `양정중` |
| 중등 "중2" 염경중학교 | `염경중중2` | `염경중` |
| 중등 "중3" 목일중 | `목일중중3` | `목일중` |
| (level/grade 비정상) 신도림중 | `신도림중` | `초` |

**해석:** legacy 출력(`당산중중3`)은 school에 학부글자가 이미 든 데이터에 학부를 또 붙인
**깨진 표시**였다. shared는 `parseInt("중3")=NaN`이라 학년을 0으로 보고 생략 →
학교명까지는 DUP 처리로 정상(`당산중`)이나 학년이 빠진다. 이는 **마스터 grade 표기 품질
이슈**이며 DB가 같은 `studentFullLabel`로 통일해도 동일하게 나타난다.
DSC는 `students` 읽기 전용 → grade 정정 불가(DB에서 grade를 `"3"`으로 정정하면 자동 반영).
"DB와 완전히 동일한 라벨 체계" 목표에는 부합(읽기 측 동작 일치).

### 빌드·테스트
- `npm run build` (Vite): **성공** (747 modules, 8s, 에러 0). 500kB 청크 경고는 기존부터 존재.
- `npm test`: **19/19 통과**.
- shared bump 후 baseline 빌드도 성공 — 기존 import(history/enrollment-*/promote-enroll/
  student-number) 회귀 없음.

---

## 6. 핵심 요약

1. DSC 표시(8곳)·검색(4곳) 라벨을 DB와 동일한 shared `studentFullLabel`(예측 학부·연 진급·
   졸업 반영) 기준으로 통일. 소비처 import 경로 무변경(래퍼 재노출).
2. shared `#v1.12.0 → #v1.15.0` bump(lockfile 캐시 commit 강제 갱신), student-label 정상 로드.
3. 검색어는 **(a) DSC 로컬 재작성** 택일(shared 신설 보류 — exam 단계에서 공통화). 표시/검색
   기준 입력 일치로 R4 해소, 다단계 부분일치 UX 유지.
4. dead code 5함수 제거, school-normalizer.js 63→27줄.
5. 활성 408건 diff: grade 정상 학생 변동 0건(완전 동일). 변동 8건은 전부 마스터 grade 비숫자
   표기 품질 이슈(읽기 전용이라 DSC에서 정정 불가, DB 정정 시 자동 반영).
6. Vite 빌드 성공 + 테스트 19/19 통과. 커밋·푸시는 미수행(오케스트레이터 조율 대기).
