# 영향 분석: exam 컬렉션 write 규칙을 isAuthorized() → 역할 기반(exam_users.role)으로 강화

## 요약 결론 (먼저 읽을 것)

1. **역할 소스는 `exam_users.role` 하나로 결정** — 값은 `'owner'` / `'teacher'` 2종뿐. HR `getUserRole()`(HR_users)은 **쓸 수 없음**: exam 채점 교사는 HR_users 문서가 없을 수 있어 `get()` 실패 → 무조건 거부된다(코드상 exam 앱은 인원현황 권한에만 HR_users를 별도로 읽고 fail-closed 처리 — `usePopulationPerms.ts`).
2. **exam 앱에는 프론트 role 게이트가 사실상 없다.** `user.role`을 쓰는 곳은 Sidebar 표시 1곳(`"원장"`/`"선생님"`)뿐. 설정 화면(`관리`=departments)조차 nav에서 전원 노출. → 규칙만 조이면 UI는 그대로 노출된 채 write가 조용히 실패한다.
3. **`answer_keys`·`exam_templates`는 이미 Admin SDK(server)만 write** → rules로 조여도 실제 플로우에 영향 없음. client write 규칙을 `false`로 낮춰도 안전(현재 client write 경로 0개).
4. **⚠️ `results/{examId}/students`(OCR 채점 저장)는 teacher가 client SDK로 직접 write.** owner 전용으로 조이면 채점 전체가 깨진다. → 반드시 **teacher 이상** 유지.
5. **다른 앱(DB/DSC/HR/DashBoard) 영향 없음** — 프로덕션 코드에서 이 컬렉션들을 read/write하지 않음. qbank는 `exams`를 **Admin SDK `.cjs` 스크립트**로만 접근(rules 무관). 단 firestore.rules 파일 자체는 4개 앱(DB/DSC/HR/exam)에 **복사 동기화** 필요.

---

## 영향받는 앱
- [x] **exam** — 대상 컬렉션 write 주체. 규칙 강화의 실질 영향은 전부 여기로 집중. 프론트 role 게이트 추가 병행 필요.
- [ ] DB — 프로덕션 코드 영향 없음. (단 firestore.rules 사본 보유 → **파일 동기화 대상**, 그리고 rules 에뮬레이터 테스트가 DB repo `tests/`에 존재)
- [ ] DSC — 영향 없음(해당 컬렉션 미사용). rules 파일 동기화만.
- [ ] HR — 영향 없음(미사용). rules 파일 동기화만.
- [ ] tablet — 무관.
- [ ] functions(백엔드) — 무관. (단 exam 앱 자체 Next.js server가 answer_keys/exam_templates를 Admin SDK로 write — rules 미적용, 분류만)
- [~] **qbank(5번째 앱, rules-sync 대상 아님)** — `exams`를 Admin SDK로 공유. rules 강화 영향 없음(admin은 rules 우회). 참고만.

## 영향받는 컬렉션

| 컬렉션 | 실제 write 경로 | 변경 유형(위험) | 권장 조건 |
|--------|----------------|----------------|-----------|
| `results/{examId}/students` | **client SDK (teacher)** | Rules 강화 — **매우 위험**(OCR 채점) | teacher 이상 |
| `exams` | client SDK (teacher) | Rules 강화 — 위험(채점 셋업) | teacher 이상 |
| `external_score_events` (+students) | client SDK (teacher) | Rules 강화 — 위험(내신 입력) | teacher 이상 |
| `exam_notifications` | client SDK (teacher) | Rules 강화 — 보통 | teacher 이상 (create만) |
| `exam_sets` | client SDK | Rules 강화 — 보통 | teacher 이상(설계 판단) |
| `departments` | client SDK (게이트 없음) | Rules 강화 — 위험(현행 교사 편집 가능) | owner 전용 + 프론트 게이트 |
| `examTypes` | client SDK (게이트 없음) | Rules 강화 — 위험(동상) | owner 전용 + 프론트 게이트 |
| `answer_keys` | **Admin SDK만**(client write 0) | client write:false 무해 | client write=false / read isAuthorized |
| `exam_templates` | **Admin SDK만**(client write 0) | client write:false 무해 | client write=false / read isAuthorized |
| `exam_analyses` | client(createdBy) | 이미 제한됨 — 변경 불필요 | 현행 유지 |

---

## 영향받는 파일 (write 경로 전수)

### 컬렉션별 write 경로 표

| 컬렉션 | 파일:라인 | 플로우 | 실행 주체 | 권장 rules 조건 |
|--------|-----------|--------|-----------|-----------------|
| **results/{examId}/students** | `src/client/hooks/useResults.ts:74` (setDocument merge) | OCR 채점 결과 멱등 저장 addResult | teacher | teacher 이상 |
| | `src/client/hooks/useResults.ts:97` (updateDocument) | 결과 수정 updateResult | teacher | teacher 이상 |
| | `src/client/hooks/useResults.ts:132-135` (writeBatch set+delete) | 재배치 saveResult | teacher | teacher 이상 |
| | `src/client/hooks/useResults.ts:44,80` (createDoc/delete stale) | 식별불가 신규/레거시 청소 | teacher | teacher 이상 |
| | `src/client/hooks/useOcrGrading.ts:691` (deleteDocument) | 저장된 결과 삭제(재스캔) | teacher | teacher 이상 |
| | `src/app/(dashboard)/placement/page.tsx:56` (updateDocument) | 반배정 assignedClass 저장 | teacher | teacher 이상 |
| | `src/app/(dashboard)/grading/page.tsx:569` (updateResult) | 카드 인라인 결과 수정 | teacher | teacher 이상 |
| **exams** | `src/client/hooks/useExam.ts:61` (createDoc) `createExam()` | 시험 생성 | teacher | teacher 이상 |
| | `src/client/hooks/useExam.ts:53` (updateDocument) | 시험 수정 | teacher | teacher 이상 |
| | `src/app/(dashboard)/grading/page.tsx:190,165,123` | 채점 페이지 생성/수정/삭제 | teacher | teacher 이상 |
| | `src/app/(dashboard)/grading/new/page.tsx:181` (createExam) | 새 채점 생성 | teacher | teacher 이상 |
| | `src/app/(dashboard)/scoring/page.tsx:40` (deleteDocument) | 시험 삭제 | teacher | teacher 이상 |
| | *(qbank `.cjs` `db.collection('exams')` — **Admin SDK**, rules 무관)* | mock 데이터 | 스크립트 | 영향 없음 |
| **external_score_events** (+students) | `src/client/hooks/useExternalScores.ts:74` (createDoc) `addEvent` | 내신/모의 이벤트 생성 | teacher | teacher 이상 |
| | `src/client/hooks/useExternalScores.ts:116,129` (setDoc students merge) | 외부성적 학생행 저장 saveScores/saveScore | teacher | teacher 이상 |
| **exam_notifications** | `src/app/(dashboard)/notifications/page.tsx:76` (createDoc) | 알림 생성(create만) | teacher | teacher 이상, create only |
| **exam_sets** | `src/client/hooks/useExamSets.ts:78,90,94,102` (createDoc/updateDocument/arrayUnion/delete) | 수능인덱스 묶음 CRUD | teacher(무게이트) | teacher 이상 |
| | `src/app/(dashboard)/index-exam/page.tsx:29,45` | 수능인덱스 화면 | teacher | teacher 이상 |
| **departments** | `src/client/hooks/useDepartments.ts:91,96,100` (create/update/delete) | 학부 설정 CRUD | **게이트 없음(전원)** | **owner 전용** |
| | `src/app/(dashboard)/settings/departments/page.tsx:102,122` | `관리` 화면(nav 전원 노출) | 전원 | owner 전용 |
| **examTypes** | `src/client/hooks/useExamTypes.ts:31,34,39,45` (add/update/remove/seed) | 시험종류 CRUD | **게이트 없음(전원)** | **owner 전용** |
| | `src/app/(dashboard)/settings/exam-types/page.tsx:40` | 설정 화면 | 전원 | owner 전용 |
| **answer_keys** | `src/server/answer-keys/create.ts:39` (`adminDb().set`) | 정답표 생성 | **Admin SDK(server)** | client write=false 무해 |
| | `src/server/answer-keys/update.ts:17` (`adminDb().update`) | 정답표 수정 | Admin SDK | client write=false |
| | `src/server/answer-keys/delete.ts:4` (`adminDb().delete`) | 정답표 삭제 | Admin SDK | 이미 delete:false |
| **exam_templates** | `src/server/grading/subjective-rubric.ts:27` (`adminDb().set`) | 서술형 채점기준(`subjective_grading_rubric`) 저장 | **Admin SDK(server)** | client write=false 무해 |

### 읽기 헬퍼 / 클라이언트 firestore 래퍼
- `src/client/firebase/firestore.ts` — `createDoc`/`updateDocument`/`setDocument`/`deleteDocument` (모든 client write가 여기 경유, path 인자만 다름). 역할 게이트 없음.
- `src/client/hooks/useAuth.ts:45-59` — `ensureUserProfile()` 첫 로그인 프로비저닝: `fetchDoc('exam_users')` → 없으면 `setDoc(exam_users/uid, {role:'teacher'})`. **로그인 시 await로 동기 완료** 후 UI 렌더.
- `src/client/hooks/usePopulationPerms.ts:29-37` — 인원현황 권한만 `HR_users/{uid}` 읽음(owner/director/permission). exam_users와 별개, fail-closed. → **HR role을 exam 컬렉션 규칙 근거로 쓰면 안 되는 증거.**

---

## exam_users role 체계 정리

- **값 목록: `'owner'`, `'teacher'` 2종만.** (`useAuth.ts:54` 기본 `teacher`, `Sidebar.tsx:86` `owner`→"원장" / 그 외→"선생님". 코드 전역에 다른 role 리터럴 없음.)
- 프로비저닝: 첫 로그인 시 client가 자기 문서 `role:'teacher'`로 self-create(rules `exam_users` 블록 line 231-233이 정확히 이 create만 허용). owner 승격은 owner만(line 240-241, `isExamOwner()`).
- 기존 rules `isExamOwner()`는 **`match /exam_users` 블록 안에 로컬 정의**(line 221-225) — 다른 컬렉션 블록(1078~)에서 호출 불가. **최상위로 헬퍼 hoist 필요.**
- `isExamOwner()`는 이미 `exists(exam_users/uid) && get(...).data.role == 'owner'` 패턴 — provisioning 전 문서 부재 시 `exists()`로 가드해 규칙 평가 에러 없이 false. **신규 헬퍼도 반드시 exists() 가드.**

---

## 권장 역할 조건 설계안

### 1) 최상위 전역 헬퍼 hoist (getUserRole 근처, line 27~53 영역)
```
function examUserRole() {
  return exists(/databases/$(database)/documents/exam_users/$(request.auth.uid))
    ? get(/databases/$(database)/documents/exam_users/$(request.auth.uid)).data.role
    : '';
}
function isExamMember() { return isAuthorized() && examUserRole() in ['teacher', 'owner']; }
function isExamOwnerG() { return isAuthorized() && examUserRole() == 'owner'; }
```
- `exists()` 삼항으로 문서 부재 시 `''` 반환 → 규칙 에러 없이 fail-closed(deny). `in [...]`으로 미래 role 추가에도 견고.
- `match /exam_users` 블록의 로컬 `isExamOwner()`는 그대로 두거나 `isExamOwnerG()`로 대체(동작 동일). **기존 exam-users 테스트 회귀 확인 필수.**

### 2) 컬렉션별 적용
| 컬렉션 | read | create/update/delete |
|--------|------|----------------------|
| `departments` | isAuthorized() | **isExamOwnerG()** (설정성) |
| `examTypes` | isAuthorized() | **isExamOwnerG()** (설정성) |
| `exam_templates` | isAuthorized() | **false** (client write 경로 0 — admin만) |
| `answer_keys` | isAuthorized() | create/update **false**(admin만), delete 이미 false |
| `exams` | isAuthorized() | **isExamMember()** |
| `results/{examId}/students` | isAuthorized() | **isExamMember()** ← OCR 채점, 절대 owner 전용 금지 |
| `external_score_events` (+students) | isAuthorized() | **isExamMember()** |
| `exam_notifications` | isAuthorized() | create **isExamMember()** |
| `exam_sets` | isAuthorized() | **isExamMember()** (또는 설정성 판단 시 owner — 현행 무게이트라 owner화 시 프론트 게이트 병행) |
| `exam_analyses` | 현행 유지(createdBy) | 현행 유지 |

- 설계 근거: **채점·성적 입력·시험 운영 = teacher 이상(현행 워크플로우 보존), 설정성(학부/시험종류/채점기준/정답표) = owner 또는 admin-only.**
- 주의: `isExamMember()`는 사실상 "exam_users 문서 보유 + role∈{teacher,owner}" = provisioning 완료된 exam 사용자. `isAuthorized()`(임의 impact7 이메일) 대비 실질 강화 효과는 **exam을 안 쓰는 DB/HR 직원 계정의 exam 컬렉션 write 차단**. teacher/owner에겐 거의 무변화.

---

## 위험도

- **수준: 높음 (설계대로 분할 적용 시 보통, 순진하게 owner 전용 일괄 적용 시 매우 높음)**
- 사유:
  1. **OCR 채점(`results/students`)이 teacher client SDK write** — owner 전용화 시 채점 저장·수정·재배치·삭제 전부 붕괴. (`useResults.ts`, `useOcrGrading.ts:691`, `placement/page.tsx:56`, `grading/page.tsx:569`)
  2. **프론트 role 게이트 부재** — 규칙만 조이면 `관리`(departments)·시험종류 화면이 teacher에게 계속 보이는데 저장만 permission-denied로 실패(UX 붕괴). owner 전용 컬렉션은 **프론트에서 nav/버튼 게이트 병행 필수.**
  3. **provisioning 창(window)** — 신규 사용자 첫 로그인 직후 exam_users 문서 생성 전에 role-gated write가 실행되면 거부. 현재는 `ensureUserProfile`를 await 후 UI 렌더라 실무상 안전하지만, `exists()` 가드 없는 `get().data.role`은 규칙 평가 에러를 유발하므로 헬퍼는 반드시 exists() 가드.
  4. **성능/비용** — role-gated write마다 `get(exam_users/uid)` 1회(문서 read 과금·지연). OCR 채점 배치는 학생 수만큼 write → 그만큼 rules get() 추가. 단일 요청 내 get/exists ≤10 한도 유의(각 write는 별도 요청이라 문서당 1 get, 한도 초과 위험은 낮음).
- 낮은 위험 요소: `answer_keys`/`exam_templates`는 admin SDK만이라 client write=false로 낮춰도 무해. 다른 앱(DB/DSC/HR/DashBoard) 프로덕션 무영향. qbank는 admin.

---

## 다른 앱 영향 여부 (rules 파일 동기화 대상 4개 앱)

- **코드 영향**: exam 외 앱(DB/DSC/HR/DashBoard) 프로덕션 코드에서 대상 컬렉션 미사용 → 런타임 영향 0. (grep 확인: DB는 `tests/`의 rules 테스트에서만 exam_users 언급, DSC/HR/DashBoard는 매치 없음.)
- **파일 동기화 의무**: `firestore.rules`는 impact7DB가 SSoT이고 DB/DSC/HR/exam 4개 repo가 사본 보유 → 규칙 수정 후 **`firestore-rules-sync` 스킬로 4개 앱에 복사**(CRLF 보존 `cp`). exam 블록만 바뀌어도 파일 단위 동기화.
- **qbank**: rules-sync 대상 아님. `exams`를 Admin SDK `.cjs`로 접근하므로 rules 강화와 무관(admin 우회). exam 앱 `useExam.ts:14-17`은 qbank mock(`deptId`/`examSetId` 없는 문서)을 read 시 필터링만 함 — 데이터 공존 이슈일 뿐 규칙과 무관.
- 배포: `firebase deploy --only firestore:rules --project impact7db` (impact7DB에서만).

---

## rules 에뮬레이터 테스트 시나리오 (필수 목록)

테스트 하네스: `tests/firestore-rules-helpers.js`(`createTestEnv`, `authedCtx`, `unauthedCtx`) + `@firebase/rules-unit-testing`. exam_users 문서를 `withSecurityRulesDisabled`로 시드해 role별 컨텍스트 구성(기존 `firestore.rules.exam-users.test.js` 패턴 재사용). 신규 파일 예: `tests/firestore.rules.exam-role-write.test.js`.

**PASS 되어야 (회귀 방지 — teacher 워크플로우):**
1. teacher가 `results/{examId}/students/{sid}` create/update/delete 성공 ← **OCR 채점 핵심**
2. teacher가 `results/{examId}/students`에 writeBatch(set+delete) 성공 (재배치 saveResult)
3. teacher가 `exams` create/update/delete 성공
4. teacher가 `external_score_events` 및 `.../students` create/update(merge) 성공
5. teacher가 `exam_notifications` create 성공
6. teacher가 `exam_sets` create/update/delete 성공(설계상 teacher 유지 시)
7. owner가 위 전부 성공(상위 포함)
8. owner가 `departments`/`examTypes` create/update/delete 성공
9. teacher 자기문서 exam_users self-create(role:teacher)·displayName update 여전히 성공(hoisting 회귀 확인)

**DENY 되어야 (강화 목적):**
10. teacher가 `departments` write 거부 (owner 전용)
11. teacher가 `examTypes` write 거부
12. 클라이언트(teacher/owner 무관)가 `exam_templates` write 거부 (admin only)
13. 클라이언트가 `answer_keys` create/update/delete 거부 (admin only, delete는 기존 false)
14. **exam_users 문서 없는 인증 사용자**(provisioning 전 / DB·HR 직원 계정)가 `results/students`·`exams`·`departments` write 거부 — **규칙 평가 에러가 아니라 clean deny**인지 확인(exists() 가드 검증)
15. 외부(비 impact7) 도메인 컨텍스트가 모든 대상 컬렉션 read/write 거부(현행 isAuthorized 유지 확인)
16. teacher가 owner 컬렉션 write 시도가 permission-denied(에러 스택 아님)로 실패

**주의(에뮬레이터로 검증 불가 — 코드 리뷰로 확인):**
- `answer_keys`/`exam_templates` Admin SDK write는 rules 우회이므로 에뮬레이터 테스트 대상 아님. client write=false로 낮춰도 server 플로우 정상인지 exam 앱 e2e(정답표 생성/서술형 기준 저장)로 별도 확인.

---

## 구현 순서 권장

1. **exam 앱 프론트 role 게이트 선행/병행** — owner 전용화할 `departments`/`examTypes`(및 exam_sets를 owner화할 경우) 화면·nav를 teacher에게 숨김(`nav-config.ts` + 페이지 가드). 규칙보다 먼저 배포하면 안전(규칙만 먼저 조이면 teacher UX 붕괴).
2. **firestore.rules 헬퍼 hoist** — `examUserRole()`/`isExamMember()`/`isExamOwnerG()`를 최상위에 추가(exists() 가드). `match /exam_users` 로컬 `isExamOwner()`는 유지 또는 대체.
3. **컬렉션 블록 조건 교체** (위 표대로): results/exams/external_score_events/exam_notifications/exam_sets → isExamMember(); departments/examTypes → isExamOwnerG(); exam_templates/answer_keys client write → false.
4. **에뮬레이터 테스트 작성·통과**(위 시나리오 16종) — 특히 #1(OCR 채점)·#14(문서 부재 clean deny)·#9(exam_users 회귀).
5. **`firestore-rules-sync` 스킬로 4개 앱 동기화** → `firebase deploy --only firestore:rules --project impact7db`.
6. **배포 후 스모크**: teacher 계정으로 OCR 채점 저장·시험 생성·내신 입력 정상 확인 / owner 계정으로 학부·시험종류 설정 확인 / teacher가 설정 화면 접근 불가 확인.

## 주의사항 (크로스앱)
- **가장 큰 함정**: `results/{examId}/students`를 owner 전용으로 조이는 것 = 채점 마비. teacher 이상으로만 강화.
- 규칙과 UI 게이트를 **원자적으로** 다루지 못하면(규칙 먼저 배포) teacher가 기존에 쓰던 설정 화면에서 저장 실패 → 반드시 프론트 게이트 선행.
- `exam_users` 문서 부재 사용자(첫 로그인 순간, 또는 exam을 안 쓰는 다른 impact7 앱 직원)의 write는 이제 전부 deny — 의도된 강화지만, exam 신규 사용자 온보딩(첫 write까지의 순서)이 provisioning(await) 뒤에 오는지 재확인.
- rules 파일은 4개 repo 사본 동기화 의무(CRLF 보존). exam 블록만 바뀌어도 파일 전체 복사.
- answer_keys/exam_templates는 admin-only라 규칙 강화가 "심층 방어(defense-in-depth)"일 뿐 — client write=false로 명시하면 미래에 실수로 client write를 붙였을 때 즉시 차단되는 안전장치가 된다.
