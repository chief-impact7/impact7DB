# 영향 분석: DB·DSC 학생 상세에 "이전 학원생활" 뷰 신설

## 1. 요약

재입학 학생의 과거 이력(담당 선생 변천사, 과거 반·수업, 휴/퇴원 사유·일자)을 DB·DSC 학생 상세에 신설하는 작업이다. 분석 결과 **3가지 정보 모두 부분적으로만 재구성 가능**:

- ✅ 과거 수업 이력 → `students.enrollments[]` + `history_logs` 파싱 (단, 정규는 종강 시 enrollments에서 제거되므로 history_logs 텍스트 파싱 필요)
- ✅ 휴/퇴원 사유·일자 → `leave_requests.consultation_note` + `history_logs.STATUS_CHANGE.timestamp`
- ❌ **과거 담당 선생 변천사 → 현재 데이터로 재구성 불가**
  - `class_settings.teacher`는 현재 상태만 저장 (변경 이력 미기록)
  - `students.enrollments[]`에 `teacher` 필드 없음
  - `auditSet/auditUpdate`는 `audit_logs`에 스냅샷 미기록 (`auditDelete`만 기록)
  - → 별도 스냅샷 메커니즘 도입 필수 (Phase 2)

종합 위험도: **중간**. Phase 1은 읽기 전용·룰 변경 없음(낮음). Phase 2(담당 선생 변천사)는 신규 컬렉션·4프로젝트 룰 동기화 필요(중간~높음).

## 2. 영향받는 앱·컬렉션 매트릭스

| 컬렉션 | DB | DSC | HR | exam | 본 작업에서의 역할 |
|---|:---:|:---:|:---:|:---:|---|
| `students` (특히 `enrollments[]`) | R | R | - | R | 과거 수업 목록 재구성 SoT |
| `history_logs` | R | R | - | - | 휴/퇴원·종강·STATUS_CHANGE 일자 |
| `leave_requests` | R | R | - | - | 휴/퇴원 사유(`consultation_note`) 및 일자 |
| `class_settings` | R | R | - | - | 현재 담당 선생 (변경 이력 없음) |
| `teachers` | - | R | - | - | 이메일 → 이름 매핑 |
| `firestore.rules` | RW | RW | RW | RW | Phase 2 시 4프로젝트 동기화 필수 |

영향 앱: **DB / DSC**. HR·exam은 본 작업 무관.

## 3. 데이터 출처 스키마 실측 결과

### 3-1. `students.enrollments[]` 구조

`app.js:2486-2498`, `:2715-2716`:
```
{ class_type, level_symbol, class_number, day, start_date, semester, [end_date] }
```
- `enrollmentCode(e) = level_symbol + class_number` (`app.js:122`)
- `class_type`: '정규' | '내신' | '자유학기' | '특강' | '문법특강' 등
- 만료 판정: `end_date < today` (`app.js:233-234`)
- **`teacher` 필드 없음**
- 룰 화이트리스트(`firestore.rules:42-46`)는 `enrollments`를 list로만 검증, 내부 키 미검증

### 3-2. `history_logs` 실제 포맷

`change_type` enum (`firestore.rules:132`):
```
['ENROLL', 'UPDATE', 'WITHDRAW', 'DELETE', 'RETURN', 'STATUS_CHANGE']
```

**⚠️ 별건 발견**: 코드(`app.js:4002-4003`의 `_categorizeHistoryLog`)는 `RESTORE`와 `LR_AMEND`도 분류하지만 **룰 enum에 포함되어 있지 않음** → write 시도가 있다면 차단됨.

`before`/`after`는 **string**, 두 패턴 혼재 (`app.js:3960-3987` `_summarizeHistoryText`가 처리):
- JSON: `STATUS_CHANGE = JSON.stringify({status: '...'})` (`app.js:2148-2149`)
- 자유 텍스트: `종강 처리: HA101 (정규) → 퇴원 (다른 수업 없음)` (`app.js:2872-2877`), `수업 추가: HA101 (정규)` (`app.js:2760`)

**휴/퇴원 사유는 `history_logs.after`에 없다** → `leave_requests.consultation_note`에 있음.

### 3-3. `leave_requests` 스키마

룰(`firestore.rules:484-499`) + 사용처(`app.js:4835-4897`):
- `request_type`: '휴원요청' | '휴원연장' | '퇴원요청' | '휴원→퇴원' | '퇴원→휴원' | '복귀요청' | '재등원요청'
- `leave_sub_type`: 휴원 종류 부기
- 일자: `leave_start_date / leave_end_date / withdrawal_date / return_date`
- **사유: `consultation_note`** (`app.js:4850`, `:5121`)
- `status`: 'requested' | 'approved' | 'rejected' | 'cancelled'
- 학생별 조회 헬퍼 이미 존재: `fetchStudentLeaveRequests` (`app.js:4919-4924`)

### 3-4. `class_settings` — 담당 선생

`firestore.rules:340-347` 화이트리스트에 `teacher`, `sub_teacher`.
- 이메일(예: `lee@gw.impact7.kr`) — DSC `class-setup.js:1023`에서 `@` 앞부분만 표시
- **변경 이력 없음**: `saveTeacherAssign`(`impact7newDSC/class-detail.js:1164-1175`) → `saveClassSettings → auditSet`만 호출 (`updated_by/updated_at`만 갱신)
- `auditSet/auditUpdate`(`audit.js:49-62`)는 `audit_logs` 미기록 — `auditDelete`만 스냅샷 남김 (`audit.js:64-82`)

### 3-5. `teachers` 컬렉션

`firestore.rules:554-566`. 로그인 시 자동 등록. doc ID = email. 이메일 → 이름 매핑용.

### 3-6. 현재 상세 화면 UI

**DB** (`index.html:397-517`):
- `#detail-tab-bar`에 2개 탭: "기본정보"·"수업이력"
- `app.js:3906-3923` `switchDetailTab(tab)` — `'history'` 분기만 존재

**DSC** (`index.html:228-265`):
- `#detail-tabs`에 3개 탭: "일일현황"·"출결현황"·"성적"
- `student-detail.js:382-395` `switchDetailTab(tab)`

### 3-7. Firestore 인덱스

`firestore.indexes.json:3-9`에 이미 `history_logs: doc_id ASC + timestamp DESC` 존재. Phase 1 쿼리(`app.js:3935-3940`) 그대로 활용. **추가 인덱스 불필요.**

## 4. 단계별 구현 계획

### Phase 1 — DB 단독 (위험도 낮음, 즉시 구현 가능)

**범위**:
1. 과거 수업/반 이력: `enrollments[]` 중 `end_date < today` + 정규 종강은 `history_logs` 텍스트 파싱으로 보강
2. 휴/퇴원 일자·사유: `leave_requests.consultation_note` + STATUS_CHANGE `timestamp`
3. 현재 담당 선생 표시 (변천사가 아니라 현재 상태만): 활성 enrollment의 `enrollmentCode` → `class_settings[code].teacher` → `teachers/{email}.display_name`

**모듈 분리** (AGENTS.md 규칙 1·3):
- 신설 `past-history.js` (DB 측)
- `store.js`에서 `currentStudentId`, `allStudents` import
- `window.loadPastHistory` 등록은 새 모듈 안에서
- `index.html:397-401`에 새 탭 버튼 + `<div id="past-view">` 추가
- `app.js:3906-3923` `switchDetailTab`에 `'past'` 분기 추가 (소규모 수정 — 분리는 비용 대비 효과 작음)

**예상 추가 Firestore reads / 학생 1명당**: 탭 전환 시 1~2회. `fetchStudentLeaveRequests`, `history_logs` 쿼리 모두 이미 다른 곳에서 호출되어 캐싱 가능 → **사실상 추가 비용 0**.

### Phase 2 — 담당 선생 변천사 (위험도 중간~높음)

세 옵션 비교:

| 옵션 | 방식 | 룰 변경 | 과거 데이터 백필 가능 | 비용 |
|---|---|:---:|:---:|---|
| **A (권장)** | 신규 컬렉션 `class_teacher_history` | 4프로젝트 동기화 | ❌ 도입 이후만 | 중 |
| B | `enrollments[].teacher_snapshot` 필드 | 불필요 | 부분(현재 활성만 백필) | 저~중 |
| C | `audit_logs`에 모든 class_settings 변경 기록 | audit_logs 스키마 확장 | ❌ 도입 이후만 | 고 |

**옵션 A 권장 사유**:
- SoT 명확
- DSC `saveTeacherAssign`에 단일 hook 추가만으로 자동 기록
- enrollment 라이프사이클과 분리되어 "수업 진행 중 교사 교체"도 잡힘

**한계**: 도입 이전 데이터는 영원히 비어있음. 사용자 사전 고지 필요.

### Phase 3 — DSC 미러

- `impact7newDSC/index.html:228-232` 탭 버튼 추가
- `student-detail.js:382-395` `switchDetailTab` 분기 추가
- 신설 모듈 `past-history.js` (DSC 측) — `student-detail.js`가 이미 1365줄이라 분리 권장

## 5. Rules 변경 필요 여부

| Phase | 변경 필요 | 비고 |
|---|---|---|
| Phase 1 | ❌ | DB·DSC 모두 필요한 컬렉션 read 권한 보유 |
| Phase 2 옵션 A | ✅ | `class_teacher_history` match 블록 신규 추가 → 4프로젝트 동기화 (`firestore-rules-sync` 스킬) |
| Phase 2 옵션 B | ❌ | enrollments 내부 미검증 |
| Phase 2 옵션 C | △ | `audit_logs` 화이트리스트 명시화 권장 |
| Phase 3 | ❌ | UI 미러링이라 룰 영향 없음 |

**별건 룰 버그**: `firestore.rules:132`의 `change_type` enum에 `RESTORE`, `LR_AMEND` 누락. 코드는 사용 중. 본 작업 범위 외이나 별도 패치 필요 여부 사용자 결정.

## 6. 위험도 판정

**종합: 중간**

| 항목 | 위험도 | 사유 |
|---|---|---|
| Phase 1 단독 | 낮음 | 읽기 전용, 룰·인덱스 변경 없음 |
| Phase 2 옵션 A | 중간~높음 | 4프로젝트 룰 동기화, DSC 쓰기 hook 추가, 과거 데이터 공백 |
| Phase 3 | 낮음 | UI 미러링 |
| 성능 | 낮음 | 탭 전환 시 1~2회 쿼리, 인덱스 존재 |
| 데이터 일관성 | 중간 | `before/after` JSON+자유텍스트 혼재 → 기존 `_summarizeHistoryText`/`_categorizeHistoryLog` 재사용으로 완화 |

## 7. 미해결 질문 (사용자 결정 필요)

1. **담당 선생 변천사 범위**: 도입 이후 변경만 추적되어도 충분한가? 아니면 enrollment에 teacher_snapshot 일괄 백필 작업을 별도로?
2. **"과거" 정의**: enrollment의 `end_date < today`만? 종강된 정규(enrollments에서 제거됨)도 history_logs 파싱으로 복원?
3. **노출 범위**: 모든 학생에게? 또는 재입학자(`status === '재원'` + 과거 이력 있음)에게만?
4. **휴원 사이클 묶음**: 한 휴원 사이클(휴원요청→연장→복귀)을 1개 카드로? 각 leave_requests row 모두 표시?
5. **별건 룰 버그 처리**: `RESTORE`/`LR_AMEND` 누락을 본 작업과 함께 패치? 별도 PR?
6. **DSC 모듈 위치**: 신설 모듈로 분리? 기존 `student-detail.js`에 추가?

## 8. 관련 파일 경로

**DB (`/Users/jongsooyi/projects/impact7DB/`)**:
- `app.js`: line 122 `enrollmentCode`, 2486-2498/2715-2716 enrollment 스키마, 3906-3923 `switchDetailTab`, 3929-3955 `loadHistory`, 3960-3987 `_summarizeHistoryText`, 3989-4025 `_categorizeHistoryLog`, 4790-4898 leave_request 카드, 4919-4937 `fetchStudentLeaveRequests`
- `index.html`: 397-517 detail tab + view 영역
- `store.js`: 28-48 state 정의
- `firestore.rules`: 124-152 history_logs, 481-518 leave_requests, 337-357 class_settings
- `firestore.indexes.json`: 3-9 history_logs 복합 인덱스

**DSC (`/Users/jongsooyi/projects/impact7newDSC/`)**:
- `index.html`: 228-264 detail tabs
- `student-detail.js`: 382-395 `switchDetailTab`
- `class-detail.js`: 1164-1175 `saveTeacherAssign` (변경 이력 미기록 지점)
- `leave-request.js`: 30-67 request_type 매핑
- `audit.js`: 39-92 감사 헬퍼 (auditUpdate/auditSet는 audit_logs 미기록)
- `src/shared/firestore-helpers.js`: 178 `PAST_STUDENT_STATUSES`
