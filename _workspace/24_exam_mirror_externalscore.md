# 24. exam ExternalScorePanel — 구 `school` 미러 소비 제거

작성: 2026-05-30 · 상태: **구현 완료, 커밋 전(검토 대기)** · 범위: impact7exam `ExternalScorePanel`만
근거: `_workspace/22_school_mirror_removal_analysis.md` (line 38·44·73, Phase 1-1)

---

## 0. 요약

전역 전환 후속 1번의 **exam 블로커**를 해소했다. `ExternalScorePanel`이 students 컬렉션의 구 단일 미러 `.school`을 읽던 마지막 지점(`studentSchool()`)을 `currentSchool(student)`(현재 학부 학교 `school_<level>`)로 이전했다. 외부성적표 이벤트 도메인(`event.school` 등)은 미러가 아니므로 전혀 건드리지 않았다. tsc(any 0)·build 모두 통과. 재원 학생 표본에서 미러=currentSchool 일치율 99.75%(stale 1건은 상담 단계 미입력 doc).

---

## 1. 변경 지점

### 1-1. `src/client/components/results/ExternalScorePanel.tsx`

- **import 추가** (line 12 직후):
  ```ts
  import { currentSchool } from "@impact7/shared/student-label";
  ```
- **`studentSchool()` 입력 출처 교체** (구 line 44-46):
  ```ts
  // before
  function studentSchool(student: Student) {
    return String(student.school ?? "").trim();
  }
  // after
  function studentSchool(student: Student) {
    // 현재 학부 학교(school_<level>) 기준. 구 단일 미러 `.school` 소비를 제거.
    return currentSchool(student).trim();
  }
  ```

`studentSchool()`의 **사용처는 그대로**(매칭·표시·정렬 의미 보존):
- line 241 `isSameSchoolName(studentSchool(student), selectedEvent.school)` — 학교 내신 이벤트 대상 학생 필터(동등성 비교)
- line 248 정렬 키
- line 263 draft row `school` 채움
- line 478 성적표 업로드 row `school` 채움
- line 248·294·871 표시/datalist/정렬

→ `studentSchool`은 단일 함수이므로 입력 출처만 바꾸면 모든 사용처가 일괄 이전된다.

### 1-2. `src/shared/types/impact7-shared.d.ts` (로컬 ambient, shared repo 미변경)

`currentSchool`/`SCHOOL_FIELD`는 이미 v1.15.0 시그니처로 선언돼 있었다(신규 선언 불필요). 다만 기존 param 타입이 `{ level?: string; [key: string]: unknown }`이라 **index signature 없는 `Student` 인터페이스를 인자로 넘기면 TS2345**가 났다. shared.js 실제 동작(`student[SCHOOL_FIELD[level]]` 읽기)과 일치하도록 param을 구체 학교 필드로 좁혔다:

```ts
export function currentSchool(student: {
  level?: string;
  school_elementary?: string;
  school_middle?: string;
  school_high?: string;
}): string;
```

이로써 `Student`(school_elementary/middle/high/level 보유)가 정상 대입된다. shared repo는 손대지 않음(제약 준수).

---

## 2. event 도메인 미변경 확인

`ExternalScorePanel` 내 잔여 `.school` 참조 전수 점검 결과, students 미러는 0개이고 **전부 `ExternalScoreEvent` 자체 도메인**(절대 금지 대상):

- `event.school` (line 117·127·128·310·327·334·775), `selectedEvent.school` (243)
- `eventDraft.school` (358·360·366·585·586)
- `schoolEventFilter.school` (319·717)
- `a.school`/`b.school` (146 `sameSchoolEvent`, 332·334 정렬)

이들은 외부성적표 이벤트 입력값이며 미러가 아니다 → 분석 line 69·73 지침대로 미변경.

학교명 정규화·동등성 헬퍼(`isSameSchoolName`/`canonicalSchoolName`/`schoolMatchKey`)도 현행 유지. studentSchool의 **입력 출처만** 교체했다.

---

## 3. 검증 결과

### 3-1. 타입체크 / 빌드
- `npx tsc --noEmit` → **통과(에러 0, any 0)**. (1차에 d.ts index-signature 이슈 TS2345 발생 → param 구체화로 해소, 재실행 클린)
- `npm run build` → **성공**(전 라우트 프리렌더/SSR 정상, 에러 없음).

### 3-2. 표본 데이터: 미러(.school) vs currentSchool (재원 학생)
impact7DB의 firebase-admin(ADC, projectId=impact7db)으로 `students` 전수 중 ACTIVE_STATUSES(재원/등원예정/상담/실휴원/가휴원) 학생 비교:

| 지표 | 값 |
|------|----|
| active 학생 | 407 |
| mismatch | 1 |
| **일치율** | **99.75%** |
| 미러공백·cur보유 | 0 |
| 미러보유·cur공백 | 1 (채송이, status=상담, mirror=신도림중, cur="") |

→ 분석 line 44 근거(정상 학생은 미러=현재 학부 학교) 확인. 유일한 차이는 **상담 단계라 `school_middle` 미입력 + 구 미러만 stale 보유**한 1건. 재원(在院) 학생은 0건 regression.

### 3-3. 매칭/저장 동작 논리 검증
- 학교 내신 이벤트 대상 필터(line 241)는 `currentSchool` 기준으로 동작 → 정상 학생은 기존과 동일 매칭. stale 미러 케이스(학부 필드 미입력 상담생)는 현재 학부 학교가 없으므로 해당 학교 이벤트에 매칭되지 않는데, 이는 의도된 결과(예측 학부 기준이 SSoT이고, 학부 필드가 채워지면 자동 매칭됨).
- draft row 저장 시 `school` 필드(line 263·478)는 이제 currentSchool 값으로 채워져 `ExternalScoreStudent.school`(스냅샷)도 현재 학부 학교로 기록 → 표시 일관성 향상.
- event 생성/필터/정렬은 미변경이므로 외부성적표 이벤트 자체 동작 영향 없음.

---

## 4. 제약 준수
- 커밋·푸시 안 함(오케스트레이터 검토 대기).
- ExternalScorePanel + 그 로컬 d.ts 외 다른 미러 제거(트리거 `onStudentLabelSync`·saveStudent·newtest 등)는 이번 범위 아님 — 미착수.
- shared repo 미변경(로컬 ambient만 param 구체화).

---

## 핵심 요약 (5줄)
1. `ExternalScorePanel.studentSchool()`의 입력을 `student.school`(구 미러) → `currentSchool(student)`(현재 학부 `school_<level>`)로 교체 — exam의 마지막 students 미러 소비 제거.
2. 사용처(매칭 line 241 `isSameSchoolName`, 정렬·표시·row 저장)는 단일 함수라 자동 일괄 이전. 정규화·동등성 헬퍼는 현행 유지.
3. event 도메인(`event.school`/`eventDraft.school`/`schoolEventFilter.school`)은 미러 아님 → 전수 확인 후 미변경.
4. 로컬 ambient d.ts의 `currentSchool` param을 구체 학교 필드로 좁혀 Student 대입 TS2345 해소(shared repo 미변경). tsc(any 0)+build 통과.
5. 재원 표본 일치율 99.75%(407 중 mismatch 1, 그것도 상담 단계 학부필드 미입력 stale 1건) — 매칭 보존 확인.
