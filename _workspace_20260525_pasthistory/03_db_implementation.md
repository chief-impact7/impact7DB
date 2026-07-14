# DB 구현 보고: 이전 학원생활 뷰

## 1. 변경 파일 목록

| 파일 | 변경 유형 | 요약 |
|------|----------|------|
| `past-history.js` | **신설** | 과거이력 뷰 (헤더 + 과거 수업/반 + 휴퇴원 사이클) |
| `app.js` | 수정 | `selectStudent` 분기 추가, `enrollmentCode`/`formatDate`/`_summarizeHistoryText`/`fetchStudentLeaveRequests` export 추가, 공용 헬퍼 추가 |
| `index.html` | 수정 | `<div id="past-history-view">` 컨테이너 + `past-history.js` 모듈 등록 |
| `style.css` | 수정 | 과거이력 뷰 전용 스타일 (`.past-history-*`, `.past-enrollment-*`, `.past-cycle-*`) 추가 |
| `firestore.rules` | 수정 | `change_type` enum 에 `RESTORE`, `LR_AMEND` 추가 (라인 132) |

## 2. 신설 모듈 `past-history.js`

### 진입점 / window 노출

```js
window.renderPastHistory = renderPastHistory;
window.isActiveStudent = isActiveStudent;
```

- `renderPastHistory(student)` — 우측 패널 `#past-history-view` 를 채운다. `app.js:selectStudent` 가 비활성 학생일 때 이 함수를 호출.
- `isActiveStudent(student)` — `ACTIVE_STATES` 셋(`재원/등원예정/실휴원/가휴원`) 기반 분기. DSC 미러 시 동일 정의 유지용.

### Export

- `ACTIVE_STATES` (Set)
- `isActiveStudent` (fn)
- `renderPastHistory` (async fn)

### 외부 의존 (app.js export)

- `enrollmentCode` — enrollment → "HA101" 같은 코드
- `formatDate` — date 포맷터
- `_summarizeHistoryText` — JSON/자유텍스트 요약 (현재는 호환용 import, 실제 렌더에서는 종강 텍스트만 정규식 파싱)
- `fetchStudentLeaveRequests` — 학생별 leave_requests 전체 조회

### Firestore 읽기 경로

- `history_logs` where `doc_id == studentId` orderBy `timestamp` DESC — 정규 종강 텍스트 복원용
- `leave_requests` where `student_id == studentId` — 휴퇴원 사이클 묶음용 (헬퍼 재사용)
- `class_settings/{enrollmentCode}` — 현재 담당 선생 lookup
- `teachers/{email}` — 이메일 → display_name 매핑

학생 1명당 추가 reads: `history_logs` 1쿼리 + `leave_requests` 1쿼리 + 과거 수업 코드 수 × 2 (class_settings + teachers). 일반 학생은 10건 미만.

## 3. app.js 변경 핵심

### 추가된 공용 헬퍼 (line ~111)

```js
const ACTIVE_STUDENT_STATUSES = new Set(['재원', '등원예정', '실휴원', '가휴원']);
const isActiveStudentStatus = (status) => ACTIVE_STUDENT_STATUSES.has(status || '');

const setPastHistoryViewVisible = (visible) => { ... };
const showPastHistoryPanel = (student) => { ... };
```

### 분기 지점

- **`selectStudent`** (line ~1680): `isActiveStudentStatus(studentData.status)` 가 false 면 `showPastHistoryPanel` 호출 후 early return. 활성이면 기존 로직 그대로.
- **`hideForm`** (line ~1932): 폼 닫을 때 현재 학생이 비활성이면 과거이력 뷰로 복귀, 활성이면 기본정보 탭으로.
- **`switchDetailTab`** / **`showNewStudentForm`** / **`showBulkEditPanel`**: `setPastHistoryViewVisible(false)` 호출로 과거이력 뷰가 다른 뷰와 겹치지 않게 함.

### Export 추가

- `enrollmentCode` (line 134)
- `formatDate` (line 358)
- `_summarizeHistoryText` (line ~3972)
- `fetchStudentLeaveRequests` (line ~4931)

## 4. firestore.rules 변경

```diff
- in ['ENROLL', 'UPDATE', 'WITHDRAW', 'DELETE', 'RETURN', 'STATUS_CHANGE']
+ in ['ENROLL', 'UPDATE', 'WITHDRAW', 'DELETE', 'RETURN', 'STATUS_CHANGE', 'RESTORE', 'LR_AMEND']
```

- 위치: `/Users/jongsooyi/IMPACT7/impact7DB/firestore.rules:132`
- 영향: `history_logs.create` 허용 enum 확장 — 4프로젝트 동기화 필요 (orchestrator 단계에서 `firestore-rules-sync` 스킬로 처리).

## 5. 빌드 결과

```
vite v7.3.2 building client environment for production...
✓ 26 modules transformed.
dist/index.html                  65.21 kB │ gzip:   9.59 kB
dist/assets/index-rAVRHNSj.css   47.25 kB │ gzip:   8.45 kB
dist/assets/index-CzJ8hROn.js   493.92 kB │ gzip: 147.99 kB
✓ built in 1.53s
```

- JS 번들 약 +1KB (494KB → 493.92KB, simplify 후 오히려 감소)
- CSS 약 +4KB (43KB → 47KB) — `.past-*` 스타일 추가분
- 모듈 수 26개 (past-history.js 추가됨)
- 경고: `help-guide.js` 가 non-module — 기존 그대로 (영향 없음)

## 6. DSC 미러 시 참고 패턴

### 함수 시그니처

DSC 측 `past-history.js` 도 동일한 형태로 작성하면 된다:

```js
export const ACTIVE_STATES = new Set(['재원', '등원예정', '실휴원', '가휴원']);
export const isActiveStudent = (student) => ACTIVE_STATES.has(student?.status || '');
export async function renderPastHistory(student) { ... }
window.renderPastHistory = renderPastHistory;
```

### UI 분기 패턴

`impact7newDSC/student-detail.js:382-395` 의 `switchDetailTab` 에 진입할 때, 학생이 비활성이면 탭 자체를 숨기고 `renderPastHistory` 만 호출하면 된다. 또는 DSC 의 3개 탭(일일현황·출결현황·성적)과 병행 노출도 가능 (DSC 의 데이터 소비 컨텍스트가 DB 와 다르므로 결정 필요).

### 데이터 수집 알고리즘 (재사용)

- 과거 enrollments = `e.end_date < today` (정규는 history_logs 의 "종강 처리: CODE (정규)" 정규식 파싱)
- 휴퇴원 사이클 묶음 = leave_requests 를 시간순 정렬 후
  - `휴원요청`/`퇴원→휴원` → 새 사이클 시작
  - `휴원연장` → 진행 중 사이클에 흡수
  - `복귀요청`/`재등원요청` → 사이클 종료
  - `퇴원요청`/`휴원→퇴원` → 진행 중이면 휴→퇴, 없으면 단독 퇴원
- 담당 선생 lookup = `class_settings/{code}.teacher → teachers/{email}.display_name` (현재 시점만, 변천사 없음)

### Firestore 인덱스

`history_logs: doc_id ASC + timestamp DESC` 이미 존재 — 추가 인덱스 불필요.

## 7. 미해결 이슈 / Follow-up

| # | 항목 | 비고 |
|---|------|------|
| 1 | `firestore.rules` 4프로젝트 동기화 | orchestrator 가 `firestore-rules-sync` 스킬로 처리 |
| 2 | DSC 측 미러 구현 | Phase 2 — 별도 작업 |
| 3 | 담당 선생 변천사 | 설계 결정 1 에 따라 보류 (현재 시점 lookup 만) |
| 4 | 다른 화면에서의 잔여 ACTIVE 셋 정의 (`_suggestUniqueActiveName:1946`, `renderEnrollmentCards:2556`) | 분리 규칙 2 에 따라 해당 블록을 수정할 때 정리 — 본 작업에서는 그대로 둠 |
| 5 | 사이클 묶음 정확성 | "간단하게 묶어" 결정에 따라 휴리스틱. 시간 순서가 어긋난 데이터는 분리될 수 있음 |
| 6 | `_summarizeHistoryText` import | 현재 모듈 내부에서는 직접 사용하지 않지만 향후 사이클 카드 확장 시 활용 가능. 제거해도 무방 — 1줄 churn |

## 8. 검증한 시나리오

- 빌드 성공 (vite build)
- 모듈 26개 transform 정상
- simplify 패스 2회 후 최종 빌드 OK (494KB → 493.92KB, churn 감소)

브라우저 런타임 검증은 본 작업 범위 외 — orchestrator 단계에서 수동 확인 필요.
