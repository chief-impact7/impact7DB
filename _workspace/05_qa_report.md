# QA 검증 보고서 — 이전 학원생활 뷰 (DB + DSC)

## 0. 검증 범위

- 영향받은 앱: **DB** (`/Users/jongsooyi/projects/impact7DB/`), **DSC** (`/Users/jongsooyi/projects/impact7newDSC/`)
- 검증한 컬렉션: `students.enrollments`, `history_logs`, `leave_requests`, `class_settings`, `teachers`
- 검증한 파일:
  - DB: `past-history.js`(신설), `app.js`(분기), `index.html`(컨테이너), `firestore.rules`
  - DSC: `past-history.js`(신설), `student-detail.js`(분기), `src/shared/firestore-helpers.js`(ACTIVE 셋)
  - 4프로젝트: `firestore.rules`

## 1. 요약 — **PASS-WITH-WARNINGS**

핵심 정합성(분기 기준 집합 동일, rules enum 4프로젝트 동기화, change_type 화이트리스트 일치, 빌드 성공)은 모두 통과. 알고리즘·UI 세부 표현에서 의도된 비대칭 1건 + 경미한 비대칭 4건이 있으나 데이터 일관성을 깨지 않음.

| # | 항목 | 결과 |
|---|------|:----:|
| 1 | 학생상태 분기 일관성 | **PASS** |
| 2 | 데이터 출처 사용 패턴 | **PASS-WITH-WARNINGS** |
| 3 | 정규 종강 history_logs 파싱 | **PASS-WITH-WARNINGS** |
| 4 | 휴/퇴원 사이클 묶음 알고리즘 | **PASS-WITH-WARNINGS** |
| 5 | Firestore Rules | **PASS** |
| 6 | UI 일관성 | **PASS-WITH-WARNINGS** |
| 7 | 모듈 분리 규칙 | **PASS** |
| 8 | 빌드 상태 | **PASS** |

## 2. 항목별 결과

### [1] 학생상태 분기 일관성 — PASS

**DB** (`app.js:113`):
```
const ACTIVE_STUDENT_STATUSES = new Set(['재원', '등원예정', '실휴원', '가휴원']);
```

**DB past-history.js:36** (모듈 단독 사용 대비 재선언, 양쪽 export):
```
export const ACTIVE_STATES = new Set(['재원', '등원예정', '실휴원', '가휴원']);
```

**DSC** (`past-history.js:23`):
```
export const PAST_VIEW_ACTIVE_STATES = new Set(['재원', '등원예정', '실휴원', '가휴원']);
```

세 정의 모두 **정확히 동일한 집합** `{재원, 등원예정, 실휴원, 가휴원}`. 분기 트리거 동일.

DSC의 `ACTIVE_STUDENT_STATUSES`(`src/shared/firestore-helpers.js:174-176`)는 `'상담'`을 포함하지만, 과거이력 분기에는 사용되지 않고 별도 `PAST_VIEW_ACTIVE_STATES`만 사용됨(`past-history.js:21-22` 주석에서도 그 이유 명시). 의도된 분리이며 정합성 깨짐 없음.

### [2] 데이터 출처 사용 패턴 — PASS-WITH-WARNINGS

| 항목 | DB | DSC | 일치? |
|---|---|---|:--:|
| `students.enrollments[]` 만료 판정 | `e.end_date < today` (past-history.js:83) | `e.end_date < today` (past-history.js:113-116) | ✅ |
| `history_logs` 쿼리 | `where('doc_id','==',id) orderBy('timestamp','desc')` (past-history.js:138-142) | `where('doc_id','==',id) orderBy('timestamp','asc')` (past-history.js:396-400) | ⚠️ 정렬 방향 다름 |
| `leave_requests` 조회 | `fetchStudentLeaveRequests(studentId)` → `where('student_id','==',id)` (app.js:4972-4988) | `state.leaveRequests`(전역 캐시)에서 `r.student_id === studentId` 필터 (past-history.js:217-220) | ⚠️ 조회 경로 다름 |
| `class_settings/{code}.teacher` 룩업 | `getDoc(doc(db,'class_settings',code))` (past-history.js:162) | `state.classSettings?.[code]` (past-history.js:42) | ⚠️ 캐시 vs 직접 read |
| `teachers/{email}.display_name` | `getDoc(doc(db,'teachers',email))` (past-history.js:167-169) | `state.teachersList?.find(x=>x.email===email)` (past-history.js:34) | ⚠️ 캐시 vs 직접 read |

**판단:** 쿼리 키(`doc_id`, `student_id`, doc id로서의 `code`/`email`) 모두 양쪽 동일. 차이는 **DSC가 이미 보유한 전역 캐시(state.classSettings/teachersList/leaveRequests)를 재사용**한다는 점이며, 04_dsc_implementation.md §5 표에 명시된 의도된 결정이다. 데이터 출처 SoT는 같으며 정합성 깨짐 없음.

다만 `history_logs` 정렬 방향이 다르다 (DB DESC, DSC ASC). 양쪽 모두 `parseRegularEndingsFromLogs`/`_parseClosingLogs`가 전체 로그를 훑어 텍스트 매칭하므로 결과 집합은 동일하나, 다음 항목에서 동일 코드가 여러 번 잡힐 때 누적 방식이 미세하게 다르다 (→ §3 참조).

### [3] 정규 종강 history_logs 파싱 — PASS-WITH-WARNINGS

**DB 정규식** (`past-history.js:95`):
```
/종강 처리:\s*([A-Z]+\d+)\s*\(정규\)/g
```

**DSC 정규식** (`past-history.js:61`):
```
/종강 처리:\s*([A-Z0-9]+)\s*\(\s*([^)]+?)\s*\)/g
```

**파싱 결과 형태 비교:**

| 필드 | DB | DSC |
|---|---|---|
| `code` | 캡처 그룹 1 (예: `HA101`) | 캡처 그룹 1 (예: `HA101`) |
| `class_type` | 하드코딩 `'정규'` | 캡처 그룹 2 (예: `정규`/`특강`/`내신` 등) |
| `end_date` | log.timestamp → `YYYY-MM-DD` (`toDateStr`) | log.timestamp → KST `en-CA` 포맷 (`Asia/Seoul`) |
| `semester` | 미수집 | `log.semester || ''` |
| 중복 처리 | 같은 코드 여러 번 잡히면 `byCode` Map으로 **가장 최근 timestamp 1건만** 유지 (past-history.js:104-108) | 모든 매칭을 그대로 `restored.push` (past-history.js:85-92), 후속 `_buildPastEnrollments`에서 `code|start_date` 키로 중복 제거 (past-history.js:131-134) |

**불일치 발견:**

⚠️ **WARN-1: code 정규식 패턴 차이**
- DB: `[A-Z]+\d+` — 영문 대문자 + 숫자 (예: `HA101`)
- DSC: `[A-Z0-9]+` — 영문 대문자/숫자 혼합 허용 (예: `H1A01` 같은 변종도 매칭)
- **영향:** 실제 enrollment 코드는 `level_symbol + class_number` 구성(`enrollmentCode`)이므로 `H` + `A101` 또는 `M` + `2025-1B` 같은 형태. 일반적으로는 양쪽 다 정상 매칭되지만, DSC가 더 관대해서 비표준 코드도 잡을 수 있음. 데이터 인입 측에서 표준 코드만 쓰면 차이 없음.

⚠️ **WARN-2: class_type 처리 방식 차이**
- DB는 `(정규)` 패턴만 매칭하여 결과의 `class_type`이 항상 `'정규'`.
- DSC는 괄호 내용을 캡처해 `'정규'`, `'특강'`, `'내신'` 등 다양한 class_type을 그대로 보존.
- **영향:** 설계 결정서 §2와 03_db_implementation.md §6에 따르면 본 파싱의 목적은 "정규는 종강 시 enrollments에서 제거되므로 복원"하는 것. 내신/특강은 enrollments에 종강 후에도 남아있으므로 enrollments 쪽에서 잡힌다. **DSC가 더 관대하게 잡으면 정규가 아닌 종강 로그까지 카드로 노출될 수 있다.** 단, 이미 enrollments에 있는 같은 항목은 `_buildPastEnrollments`의 중복 제거(`code|start_date` 키)에서 걸러지므로 실제 표시 결과는 거의 동일.
- **다만 DSC 중복 키는 `start_date`가 ''인 history 항목과 매칭 안 됨**(history 항목은 항상 `start_date=''`로 push됨, past-history.js:138). 즉 enrollments에 동일 코드가 있어도 `start_date`가 다르면 중복 키 미스 → 중복 카드 가능성.

⚠️ **WARN-3: 중복 제거 키 불일치**
- DB: `code|end_date` (past-history.js:429)
- DSC: `code|start_date` (past-history.js:131)
- **영향:** DB는 같은 종강일이 있으면 enrollments 쪽 우선 채택, DSC는 같은 시작일이 있으면 enrollments 쪽 우선 채택. history_logs 복원 항목의 `start_date`가 항상 비어있으므로 DSC의 키 매칭은 사실상 작동하지 않음 → DSC에서 enrollments와 history_logs가 동일 항목을 양쪽에서 잡으면 **중복 카드 표시 가능**. 단, 정규는 종강 시 enrollments에서 제거되는 정상 흐름이라면 중복이 발생하지 않음. 데이터 이상(드물게 정규가 enrollments에 남은 케이스)에서만 표면화.

**판단:** 핵심 의도(정규 종강 텍스트 복원)는 양쪽 동일하게 작동. 위 3건은 엣지케이스에서 미세하게 다른 결과를 낼 수 있는 알고리즘 차이이며, 일반 데이터에서는 결과 동일.

### [4] 휴/퇴원 사이클 묶음 알고리즘 — PASS-WITH-WARNINGS

**의미적 비교** (양쪽 request_type 처리):

| request_type | DB 동작 | DSC 동작 | 의미상 동일? |
|---|---|---|:--:|
| `휴원요청`, `퇴원→휴원` | 새 휴원 사이클 시작 (이전 사이클 닫음) | 새 휴원 사이클 시작 (이전 사이클 push) | ✅ |
| `휴원연장` | 진행 중이면 흡수 + end 갱신, 없으면 단독 사이클 시작 | 진행 중이면 흡수 + end 갱신, 없으면 단독 사이클 시작 | ✅ |
| `복귀요청` | 진행 중이면 닫고 end=return_date | 진행 중이면 닫고 return_date 설정 | ✅ |
| `재등원요청` | 진행 중이면 사이클 종료, 없으면 `return_only` 단독 카드 | 진행 중이면 사이클 종료, 없으면 `reenroll` 단독 카드 | ✅ (라벨만 다름) |
| `휴원→퇴원` | 진행 중 휴원을 `leave_to_withdraw`로 전환 후 닫음, 없으면 `withdraw` 단독 | 진행 중 휴원을 `leave_to_withdraw`로 전환 후 닫음, 없으면 `leave_to_withdraw` 단독 | ⚠️ DB는 단독일 때 `withdraw`, DSC는 `leave_to_withdraw` |
| `퇴원요청` | 진행 중이면 휴→퇴로 닫음, 없으면 `withdraw` 단독 | 항상 `withdraw` 단독 (진행 중 휴원과 합치지 않음) | ⚠️ 핵심 차이 |
| `consultation_note` | 마지막 note만 `lastNote`로 유지 (덮어쓰기) | 누적해 prefix(`[연장]`/`[복귀]`/`[퇴원전환]`) 붙여 합침 | ⚠️ 표시 방식 다름 |
| 알 수 없는 타입 | `other` 단독 카드로 노출 | 무시(skip) | ⚠️ 처리 다름 |
| 필터: `cancelled`/`rejected` | **포함** (사용자가 활동을 봐야) past-history.js:185 주석 | **제외** (`r.status !== 'cancelled' && r.status !== 'rejected'`) past-history.js:218 | ⚠️ 노출 범위 다름 |
| 정렬 키 | `leave_start_date || requested_at` (past-history.js:191) | `created_at || leave_start_date || withdrawal_date` (past-history.js:195-204) | ⚠️ 다름 |
| 카드 정렬 | 최신이 위 (`reverse()`, past-history.js:279) | 시간순(오래된 순) — 별도 reverse 없음 | ⚠️ 표시 순서 다름 |

**불일치 발견:**

⚠️ **WARN-4: `퇴원요청` 처리 비대칭** (의미 차이 있음)
- DB: 진행 중 휴원 사이클이 있으면 그 사이클을 `휴→퇴`로 닫음 (past-history.js:248-253). `퇴원요청`과 `휴원→퇴원`을 동등 취급.
- DSC: `퇴원요청`은 항상 독립 `withdraw` 카드 (past-history.js:310-321). 진행 중 휴원과 합치지 않음.
- **영향:** 실제 워크플로우에서 휴원 중 학생이 `퇴원요청`을 직접 내는 경우, DB는 1개 합쳐진 카드, DSC는 휴원 카드 + 퇴원 카드 2개로 표시. **사용자에게 보이는 카드 개수가 학생별로 다를 수 있음.**

⚠️ **WARN-5: `cancelled`/`rejected` 필터 비대칭**
- DB는 포함, DSC는 제외.
- **영향:** 취소된 휴원 요청이 있는 학생에서 DB에는 카드가 보이고 DSC에는 안 보임. 사용자 신뢰성에 영향 가능.

⚠️ **WARN-6: 카드 표시 순서 반대**
- DB는 최신이 위, DSC는 가장 오래된 사이클이 위.
- **영향:** 두 앱을 번갈아 보는 사용자에게 일관성 없음.

⚠️ **WARN-7: consultation_note 표시 방식**
- DB: 마지막 note만 (`lastNote` 덮어쓰기).
- DSC: 누적 + prefix(`[연장]`/`[복귀]`/`[퇴원전환]`)로 합쳐 줄바꿈 표시.
- **영향:** 같은 사이클의 정보량이 다름. DSC가 더 풍부.

**판단:** 동일 leave_requests 데이터를 양쪽이 "같은 사이클"로 묶긴 하지만, **카드 개수·표시 순서·노트 내용·필터 범위에서 사용자 체감 차이가 발생**. 설계서 결정 4("간단하게 묶어")는 양쪽 모두 충족하나, 동일성은 보장되지 않음. 사용자가 양해한 휴리스틱 범위로 판단.

### [5] Firestore Rules — PASS

`diff` 결과: 4개 프로젝트 `firestore.rules` **완전 동일** (출력 없음 = 동일).

```
diff -q DB/firestore.rules newDSC/firestore.rules  → 동일
diff -q DB/firestore.rules HR/firestore.rules      → 동일
diff -q DB/firestore.rules exam/firestore.rules    → 동일
```

`change_type` enum 4프로젝트 모두 동일 (`firestore.rules:132`):
```
['ENROLL', 'UPDATE', 'WITHDRAW', 'DELETE', 'RETURN', 'STATUS_CHANGE', 'RESTORE', 'LR_AMEND']
```

요구 enum과 정확히 일치. `RESTORE`/`LR_AMEND` 추가가 4프로젝트 모두에 동기화됨. `firestore-rules-sync` 스킬 실행 결과 정상.

### [6] UI 일관성 — PASS-WITH-WARNINGS

**진입 트리거 비교:**

| 항목 | DB | DSC |
|---|---|---|
| 진입 조건 | `!isActiveStudentStatus(studentData.status)` (app.js:1699) | `isPastViewStudent(student)` (student-detail.js:970) |
| 진입 시점 | `selectStudent` 안에서 early return | `renderStudentDetail` 안에서 프로필 헤더 렌더 후 early return |
| 일관성 | ✅ 동일 (비활성 학생 선택 시 발동) | ✅ |

**헤더 정보 비교:**

| 항목 | DB (past-history.js:286-316) | DSC (past-history.js:451-462) | 일치? |
|---|---|---|:--:|
| 이름 | ✅ (헤더 아바타+name) | ✅ (기존 프로필 헤더에서) | ✅ |
| 학교 | ✅ tag | ✅ ph-meta | ✅ |
| 학년 | ✅ tag (`{grade}학년`) | ✅ (`{level}{grade}` 결합) | ⚠️ 표시 형식 다름 |
| 학부(level) | ✅ tag (`{level}`) | ✅ (위와 결합) | ⚠️ |
| 현재 상태 | ✅ `tag tag-status` | ✅ `상태 <b>{status}</b>` | ✅ |
| 첫 등록일 | ✅ `student.first_registered` | ✅ enrollments[].start_date 중 최소 (`_firstEnrollmentDate`) | ⚠️ 출처 다름 |
| 마지막 활동일 | ✅ `status_changed_at` → fallback 가장 최신 history_log timestamp | ✅ enrollments end/start, cycle end/return/withdrawal, closingLog end 중 최대 | ⚠️ 출처 다름 |

⚠️ **WARN-8: 첫 등록일 출처 불일치**
- DB: `student.first_registered` 필드 (학생 문서 직접 필드)
- DSC: `enrollments[].start_date` 중 가장 빠른 것
- **영향:** `first_registered`가 없거나 enrollments의 시작일과 다른 학생에서 두 값이 다르게 보일 수 있음.

⚠️ **WARN-9: 마지막 활동일 출처 불일치**
- DB: 학생 문서의 `status_changed_at` → 없으면 가장 최신 history_log timestamp
- DSC: enrollments/cycles/closingLogs의 모든 일자 후보 중 최대값
- **영향:** 같은 학생에 대해 두 앱이 다른 "마지막 활동일"을 표시 가능.

**판단:** 표시 정보의 **종류는 동일**(이름·학교·학년·현재상태·첫등록일·마지막활동일). 다만 두 날짜의 산출 출처가 달라 값 자체가 다를 수 있음. 설계서 §"데이터 출처"에는 헤더 두 날짜의 산출 방식이 명시되지 않았으므로 어느 쪽이 정답인지는 사용자 결정 필요.

### [7] 모듈 분리 규칙 — PASS

**DB:**
- ✅ `past-history.js` 신설 (498줄)
- ✅ `store.js`(=DB의 state)에서 `state.currentStudentId` import
- ✅ `window.renderPastHistory`, `window.isActiveStudent` 모듈 내부에서 등록 (past-history.js:497-498)
- ⚠️ AGENTS.md 규칙 1("app.js에 코드를 추가하지 않는다") 부분 위반: 진입 분기를 위해 `ACTIVE_STUDENT_STATUSES`/`isActiveStudentStatus`/`setPastHistoryViewVisible`/`showPastHistoryPanel` 헬퍼가 app.js:113-138에 추가됨. 03_db_implementation.md §3.3에서 "분리는 비용 대비 효과 작음"으로 의도된 결정. AGENTS.md 규칙 2("기존 코드는 수정할 때 분리한다") 관점에서는 selectStudent 자체를 분리하지 않고 분기 진입점만 최소 수정한 것이라 수용 가능.

**DSC:**
- ✅ `past-history.js` 신설 (490줄)
- ✅ `state.js`에서 `state` import
- ✅ `window.renderPastHistory` 모듈 내부에서 등록 (past-history.js:488-490)
- ✅ `student-detail.js`(1376줄)에 추가 비대화 없음 — 진입 분기 1블록(student-detail.js:967-974) + import 1줄만 추가
- ✅ `index.html` 변경 없음 (ES module 의존 그래프로 자동 번들)

### [8] 빌드 상태 — PASS

**DB:**
```
vite v7.3.2 building client environment for production...
✓ 26 modules transformed.
dist/index.html                  65.21 kB
dist/assets/index-rAVRHNSj.css   47.25 kB
dist/assets/index-CzJ8hROn.js   493.92 kB
✓ built in 1.49s
```
`help-guide.js` non-module 경고는 기존부터 존재(영향 없음).

**DSC:**
```
vite v7.3.1 building client environment for production...
✓ 734 modules transformed.
dist/index.html                  59.63 kB
dist/assets/main-BERs9-Ua.css   60.38 kB
dist/assets/main-DObMAB4i.js   432.40 kB
✓ built in 4.42s
```
chunk size 경고는 기존 동일(본 작업과 무관).

양쪽 모두 에러 없음.

## 3. 발견된 불일치 종합 (9건)

| # | 위험도 | 위치 | 내용 |
|---|:--:|---|---|
| WARN-1 | 낮음 | DB past-history.js:95 vs DSC past-history.js:61 | code 정규식 패턴 차이 (`[A-Z]+\d+` vs `[A-Z0-9]+`) |
| WARN-2 | 낮음 | DB past-history.js:95 vs DSC past-history.js:61 | DSC가 정규 외 class_type도 history_logs로 복원 가능 |
| WARN-3 | 낮음 | DB past-history.js:429 vs DSC past-history.js:131 | 중복 제거 키 불일치 (`code\|end_date` vs `code\|start_date`) — DSC 키는 history 항목과 매칭 안 됨 |
| WARN-4 | **중간** | DB past-history.js:246-263 vs DSC past-history.js:310-321 | `퇴원요청`이 진행 중 휴원과 합쳐지는지 처리 다름 → 카드 개수 다를 수 있음 |
| WARN-5 | **중간** | DB past-history.js:186 vs DSC past-history.js:218 | `cancelled`/`rejected` 필터 비대칭 (DB 포함, DSC 제외) |
| WARN-6 | 낮음 | DB past-history.js:279 vs DSC | 카드 표시 순서 반대 (DB 최신 위, DSC 오래된 위) |
| WARN-7 | 낮음 | DB past-history.js:210 vs DSC past-history.js:254-258 등 | consultation_note 표시 방식 (마지막만 vs 누적+prefix) |
| WARN-8 | 낮음 | DB past-history.js:288 vs DSC past-history.js:366-372 | 첫 등록일 출처 (`first_registered` vs enrollments 최소 start_date) |
| WARN-9 | 낮음 | DB past-history.js:444-450 vs DSC past-history.js:374-391 | 마지막 활동일 산출 출처 다름 |

## 4. 권장 후속 조치

### 즉시 조치 권장 (중간 위험도)

1. **WARN-5 `cancelled`/`rejected` 필터 통일** — 두 앱 중 한 정책으로 정렬.
   - 옵션 A: DB 정책(포함, 모든 활동 표시) — 사용자가 "취소된 시도"도 본다.
   - 옵션 B: DSC 정책(제외) — 잡음 줄임.
   - **권장: B(제외)** — 사용자 관점에서 "취소된 휴원"은 발생하지 않은 사건. DB쪽 필터 추가로 통일.

2. **WARN-4 `퇴원요청` 처리 통일** — 진행 중 휴원이 있을 때 합칠지 결정.
   - 옵션 A: DB 정책(합쳐서 휴→퇴 1카드) — 의미상 더 정확(같은 사이클).
   - 옵션 B: DSC 정책(독립 카드 2개) — 보고된 데이터를 그대로 보여줌.
   - **권장: A(합치기)** — 학생 1명의 1개 휴원기간이 결국 퇴원으로 끝났다는 사실은 1개 사건. DSC쪽 분기 보강.

### 일관성 개선 권장 (낮은 위험도)

3. **WARN-6 표시 순서 통일** — 둘 다 "최신 위"로 통일 권장 (학생 상세에서 가장 최근 사건부터 보는 것이 자연스러움).

4. **WARN-7 consultation_note 통일** — DSC의 누적+prefix가 정보량 풍부. DB도 같은 방식 채택 권장.

5. **WARN-8/WARN-9 헤더 일자 산출 통일** — 설계 문서에 명시되지 않은 부분. 사용자에게 어느 출처를 신뢰할지 확인 필요. 권장:
   - 첫 등록: `student.first_registered`(있으면) → fallback enrollments 최소 start_date
   - 마지막 활동: max(`status_changed_at`, 가장 최신 history_log.timestamp, enrollments 모든 end_date, leave_requests 모든 일자)

### 데이터 일관성 안전망 (낮은 위험도)

6. **WARN-1/WARN-2 정규식 통일** — 둘 다 `[A-Z]+\d+` + `(정규)` 명시로 통일 권장. DSC가 너무 관대하면 의도치 않은 카드 표시 가능.

7. **WARN-3 중복 제거 키 통일** — `code|end_date`로 통일 권장 (history 복원 항목에 `start_date`가 없어 DSC 키는 사실상 작동 안 함).

### 후속 PR로 처리 가능

- `_summarizeHistoryText` import는 DB past-history.js에서 직접 사용 안 됨(03_db_implementation.md §7-6). 정리 시 제거.
- `firestore.indexes.json` 4프로젝트 동기화 상태는 본 검증 범위 외 — `history_logs: doc_id ASC + timestamp DESC` 인덱스가 DSC에도 존재하는지 확인 필요 (04_dsc_implementation.md §6-1 미해결 이슈).

## 5. 검증 외 확인사항

- **수동 브라우저 런타임 검증은 미수행** — 정적 코드 분석만. 실제 사용자가 비활성 학생을 클릭했을 때 UI가 의도대로 그려지는지는 별도 확인 필요.
- **build 후 `/simplify` 미실행** — 사용자 지시(검증만)에 따라 실행하지 않음. 본 작업이 커밋되기 전이라면 `/simplify` 실행 후 커밋 권장.

---

**검증 종료. PASS-WITH-WARNINGS — 코드 수정 없이 보고서만 작성.**
