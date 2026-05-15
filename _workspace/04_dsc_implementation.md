# DSC 구현 보고: 이전 학원생활(과거이력) 뷰

## 1. 변경 파일 목록

| 종류 | 경로 | 변경 내용 |
|---|---|---|
| 신설 | `/Users/jongsooyi/projects/impact7newDSC/past-history.js` | 과거이력 뷰 전용 모듈 (페치/집계/렌더) |
| 수정 | `/Users/jongsooyi/projects/impact7newDSC/student-detail.js` | `import { isPastViewStudent, renderPastHistory }` 추가 + `renderStudentDetail` 진입부 분기 + 탭바 display 복원 1줄 |
| 수정 | `/Users/jongsooyi/projects/impact7newDSC/daily-ops.css` | `.past-history` 계열 스타일 블록 추가 (~110줄) |

`index.html`은 변경 없음 — ES 모듈 의존 그래프(`daily-ops.js → student-detail.js → past-history.js`)로 자동 번들링되므로 별도 `<script>` 등록 불필요(중복 평가 위험 회피).

## 2. 신설 모듈의 export 구조

`past-history.js`:

```js
// 상수
export const PAST_VIEW_ACTIVE_STATES = new Set(['재원', '등원예정', '실휴원', '가휴원']);

// 분기 판정
export function isPastViewStudent(student): boolean

// 렌더 (비동기 — history_logs 페치)
export async function renderPastHistory(studentId): Promise<void>

// window 등록
window.renderPastHistory = renderPastHistory
```

내부 헬퍼(미공개): `_teacherDisplayName`, `_enrollmentTeacher`, `_parseClosingLogs`, `_buildPastEnrollments`, `_buildLeaveCycles`, `_renderEnrollmentCard`, `_renderCycleCard`, `_firstEnrollmentDate`, `_lastActivityDate`, `_fetchHistoryLogs`.

### 의존성 (외부 import)

- `firebase/firestore`: `collection`, `query`, `where`, `orderBy`, `getDocs`
- `./firebase-config.js`: `db`
- `./state.js`: `state` (leaveRequests, classSettings, teachersList, selectedStudentId)
- `./ui-utils.js`: `esc`, `escAttr`
- `./student-helpers.js`: `enrollmentCode`, `findStudent`
- `./src/shared/firestore-helpers.js`: `todayStr`

## 3. 빌드 결과

```
vite v7.3.1 building client environment for production...
✓ 734 modules transformed.
✓ built in 4.38s
```

- 에러/경고 없음(chunk size 경고는 기존 동일, 본 작업과 무관)
- 산출물: `dist/index.html` 59.63 kB, `dist/assets/main-*.js` 432.52 kB

## 4. 동작 요약

### 4-1. 분기 로직

`student-detail.js` `renderStudentDetail` 안에서, 프로필 헤더(이름/연락처/태그/재원현황)까지 렌더한 직후 학생 상태를 검사:

```js
if (isPastViewStudent(student)) {
    renderPastHistory(studentId);
    document.getElementById('detail-panel').classList.add('mobile-visible');
    return;
}
```

- 활성 상태(`재원`/`등원예정`/`실휴원`/`가휴원`) → 기존 일일현황/출결현황/성적 탭 (불변)
- 그 외(`퇴원`/`종강`/`상담` 등) → 우측 패널 본문이 과거이력 뷰로 교체, 탭바 숨김
- 활성 학생으로 다시 전환 시 탭바는 1271행 부근에서 `display=''`로 복원

### 4-2. 과거이력 뷰 구성

- **헤더 (섹션 C)**: 학교/학부·학년/현재 상태, 첫 등록일, 마지막 활동일 (프로필 헤더 아래 별도 박스)
- **섹션 A — 과거 수업·반 이력**:
  - `enrollments[]` 중 `end_date < today`인 항목
  - + `history_logs` 텍스트 파싱(`종강 처리: <code> (<class_type>)`) 결과 (정규 종강 복원)
  - 시기순 정렬, 각 카드에 반코드 / class_type / 학기 / 기간 / 담당 선생
  - 담당 선생: `class_settings[code].teacher` → `state.teachersList`에서 `display_name` 룩업 (없으면 이메일 @앞부분)
- **섹션 B — 휴원/퇴원 사이클**:
  - `state.leaveRequests`에서 해당 학생 + status가 `cancelled`/`rejected` 아닌 row를 시간순 정렬
  - 사이클 묶음 규칙: 휴원요청/퇴원→휴원 → 새 휴원 사이클 / 휴원연장 → 직전 사이클 합류 / 복귀요청·재등원요청 → 직전 사이클 종료 / 휴원→퇴원 → 사이클을 퇴원 전환 / 퇴원요청 → 독립 카드
  - 카드 내용: 사이클 종류 배지(휴원/휴원→퇴원/퇴원/재등원), 기간, `consultation_note`(연장·복귀·퇴원전환 시 prefix 부여)

## 5. DB와의 차이점·주의사항

| 항목 | 결정 |
|---|---|
| 활성 상태 집합 | **별도 정의** (`PAST_VIEW_ACTIVE_STATES`). DSC의 `firestore-helpers.js:174-176` `ACTIVE_STUDENT_STATUSES`는 `'상담'`을 포함하지만, 본 뷰는 설계 결정에 따라 `'상담'`을 과거이력 뷰로 보내야 하므로 재사용하지 않음. |
| 담당 선생 lookup | `state.teachersList`(이미 로드됨) 사용 — DSC 일관성. 미스 시 `email.split('@')[0]` fallback. 별도 `teachers` 컬렉션 페치 없음. |
| `history_logs` 페치 | 학생 상세 진입 시점에만 1회 (인덱스 `doc_id ASC + timestamp DESC` 활용 — DSC 측 인덱스 동기화 상태는 확인하지 않았으나, DB와 동일 인덱스 파일이 있다면 즉시 사용 가능). |
| `state.leaveRequests` 사용 | DSC는 `leaveRequests`를 전역으로 이미 보유 → 추가 페치 없음. DB가 `fetchStudentLeaveRequests` 별도 호출 패턴이라면 그것과 다름. |
| 모드 분기 우선순위 | 특강/내신 모드 분기(894-909행)는 본 분기보다 **앞**에 있어, 비활성 학생이 내신/특강 화면에서 클릭되면 그 모드의 별도 렌더가 우선. 일반 학생 리스트에서의 클릭은 과거이력 뷰로 진입. |
| script 등록 | ES module import 체인으로 자동 번들됨 → `index.html` 미수정. |
| firestore.rules | DSC 측은 변경 없음 (사용자 지시). |

## 6. 미해결 이슈·후속 작업 필요 항목

1. **firestore.indexes.json 동기화 확인 미수행**
   - DB는 `history_logs: doc_id ASC + timestamp DESC` 인덱스 존재 (01_impact_analysis 3-7).
   - DSC 측 인덱스 파일에 동일 인덱스가 있는지 확인하지 않았다. 없으면 첫 호출 시 콘솔에 "create index" URL이 뜬다. 사용자 결정 필요.

2. **`history_logs.timestamp` 가 누락된 로그**
   - `_parseClosingLogs`가 `timestamp` → `end_date(KST)`로 변환하는데 ts 없으면 `end_date=''`이 됨. 카드에 `?`로 표시. 매우 옛 데이터에서 발생 가능.

3. **`state.classSettings` 로드 시점 의존**
   - 비활성 학생을 클릭했을 때 `_classSettingsLoaded`가 false면 담당 선생이 모두 `—`로 표시될 수 있음. 현재 DSC 흐름상 초기 부트 후에는 로드되지만, race condition 시 빈 값. 재선택 시 복원되므로 critical하지 않다.

4. **`reenroll` 사이클 표시**
   - 휴원 기록 없이 단독 `재등원요청`만 있는 케이스(예: 과거 퇴원 → 재입학)는 독립 카드로 표시. 시기상 가장 마지막에 오는데, 사용자가 시각적으로 직전 퇴원 카드와 연결지어 보고 싶다면 후속 개선 여지 있음.

5. **사이클 묶음 알고리즘**
   - 사용자 지시("간단하게")대로 직선형 규칙을 적용. 예외 케이스(중첩 휴원, 비정상 순서) 시 부정확할 수 있음. 사용자가 양해함.

6. **`/simplify` 미실행**
   - 사용자 지시는 "코드 작성·빌드까지". `/simplify`는 커밋 전 단계로, 본 작업 범위 외로 판단해 실행하지 않음. 필요 시 별도 호출.

7. **rules sync는 별도 단계**
   - 사용자 명시대로 본 작업에서는 DSC `firestore.rules` 미변경. DB가 `RESTORE`/`LR_AMEND` enum을 추가하면 orchestrator가 `firestore-rules-sync` 스킬로 4프로젝트에 일괄 동기화 예정.

## 7. 검증 체크리스트 (수동 확인 권장)

- [ ] 재원 학생 선택 → 일일현황/출결현황/성적 탭 정상 작동 (기존 동작 보존 확인)
- [ ] 퇴원 학생 선택 → 우측 패널이 과거이력 뷰로 교체, 탭바 사라짐
- [ ] 종강 학생 선택 → 동일
- [ ] 상담 학생 선택 → 과거이력 뷰 (DSC의 ACTIVE_STUDENT_STATUSES와 다른 분기)
- [ ] 퇴원 학생 → 재원 학생으로 다시 전환 → 탭바 다시 나타남, 일일현황 표시
- [ ] 휴원 사이클이 있는 퇴원 학생: 휴원 카드 + 휴원→퇴원 또는 별도 퇴원 카드 표시
- [ ] 정규반 종강 학생: history_logs 파싱으로 과거 반 코드 카드 표시 (`log` 표시 있음)
- [ ] 담당 선생 표시: class_settings의 teacher 이메일이 teachersList의 display_name으로 표시

## 8. 관련 라인 참조

- `student-detail.js:39` — `import { isPastViewStudent, renderPastHistory } from './past-history.js'`
- `student-detail.js:967-975` (수정 후) — 분기 블록
- `student-detail.js:1273` (수정 후) — `tabsEl.style.display = '';` 복원
- `past-history.js:27-31` — `isPastViewStudent`
- `past-history.js:315-388` — `renderPastHistory`
- `daily-ops.css:끝부분` — `.past-history`, `.ph-*` 스타일
