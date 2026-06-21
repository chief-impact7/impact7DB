# 재검증 로그 — Codex 발견별 판정

각 발견을 실제 현재 코드와 대조했다. **라인 번호는 현재 파일 기준으로 정정**했다(Codex 일부는 stale).
판정: `CONFIRMED`(정확) / `PARTIAL`(부분·과대/과소) / `INACCURATE`(예시·세부 오류) / `WRONG`(틀림).

## CRITICAL

### C-01. `exam_users` 자기 권한 상승 — **CONFIRMED**
- 현재 위치: `firestore.rules:198-203` (Codex 일치)
- 검증: `allow write: if isLoggedIn() && (request.auth.uid == userId || ...role=='owner')` — 자기 문서 전체 write 가능, `role:'owner'` 자가 설정 가능. 정확.
- **보강(중요):** `allow read: if isLoggedIn()`(199) — 도메인 검사 없는 `isLoggedIn()`(`request.auth != null`)이라 **impact7 도메인 밖 외부 Firebase 계정도** exam_users 전체 read + 자기 문서 write가 가능. 조직 정책이 `allValues: ALLOW`로 완화돼 있어(AGENTS.md) 외부 구글 계정도 토큰 획득 가능 → 외부 공격자가 owner로 자가 승격. Codex가 "일반 로그인 사용자"로 본 것보다 노출면이 넓다. → 신규 발견 [N-01]과 연결.

### C-02. 비인증 HR 토큰 list/get — **CONFIRMED**
- 현재 위치(6개 컬렉션 모두 `allow read: if true`):
  - `onboardingTokens` `firestore.rules:784`
  - `contractSigningTokens` `firestore.rules:801`
  - `salaryAgreementTokens` `firestore.rules:818`
  - `shortTermTokens` `firestore.rules:864`
  - `employeeOnboardingTokens` `firestore.rules:995`
  - `employeeContractSigningTokens` `firestore.rules:1009`
- 검증: `allow read: if true`는 단건 get + 컬렉션 list 모두 허용. 정확. (Codex 범위 993-1015는 두 employee 토큰 블록을 한 범위로 묶었으나 라인은 모두 포함됨.)
- **보강:** 토큰 문서에는 `staffId`/`contractId`가 들어있어(update 허용 필드 `firestore.rules:786`, contract 검증 `firestore.rules:904`) → C-03의 공개 get과 연결되는 익스플로잇 체인. → [N-02].

### C-03. 직원 개인정보·계약서 비인증 get — **CONFIRMED**
- 현재 위치:
  - `staff/{staffId}` `allow get: if true` `firestore.rules:889`
  - `staff/.../contracts` `allow get: if true` `firestore.rules:897`
  - `employees/{employeeId}` `allow get: if true` `firestore.rules:1030`
  - `employees/.../contracts` `allow get: if true` `firestore.rules:1036`
- 검증: 문서 ID를 알면 주민번호·주소·계좌·세무·급여·서명 노출. 정확. (`get`만 허용 → `list`는 불가, 즉 ID를 알아야 함 — Codex가 "문서 ID를 알면"으로 정확히 단서 명시.)
- **보강:** [N-02] 체인 — 공개 토큰 컬렉션을 list로 긁어 `staffId`/`contractId` 수집 → 그 ID로 공개 `get` → ID 추측 없이도 전 직원 PII 일괄 수집 가능. C-02+C-03은 독립이 아니라 **결합 시 완전 PII 유출 경로**.

## HIGH

### H-01. Storage가 HR 역할·소유권 우회 — **CONFIRMED**
- 현재 위치: `storage.rules:12-38` (Codex 12-37, signatures 블록은 35-38)
- 검증: `exam-papers`/`scans`/`staff`/`contracts`/`expenses`/`signatures` 모두 `isAuthorized()`(도메인 검사뿐). impact7 직원이면(단기직 포함) 모든 HR 계약·서명·경비 read/write. Firestore의 director/assignedTo보다 훨씬 넓음. HR 경로엔 크기·MIME 제한도 없음(student-records만 `storage.rules:44-46`에 제한). 정확.

### H-02. `llmGenerate` 비용 악용 — **CONFIRMED (정확, 범위 정밀)**
- 현재 위치: `functions-shared/src/llmHandler.js:36-39` (Codex 일치)
- 검증: `if (!request.auth) throw 'unauthenticated'`만. `assertAuthorizedStaff()`/`isAuthorizedStaffEmail()` 헬퍼는 `functions-shared/src/authGuards.js:5-17`에 **존재하나 미적용**. rate limit/quota/App Check 없음(`index.js:40` `enforceAppCheck:false`). 외부 인증 계정이 유료 Vertex 호출 반복 가능.
- **보강:** 전 callable 감사 결과 **llmGenerate가 유일하게 도메인 미검증**. 나머지(checkin/tabletCheckin/studentReportAi/promoCampaign/bulkMessage 등)는 `assertAuthorizedStaff` 적용됨. App Check는 **전 callable 부재** → [N-05]. `paymentHook`은 public·서명검증 없음이나 현재 stub(503) → [N-09].

### H-03. `app.js`↔`store.js` 상태 분리 — **PARTIAL (과대평가 → 하향)**
- 현재 위치: app.js 지역변수 `currentStudentId`(`app.js:153`), `allStudents`(`app.js:154`); store는 `store.js:28-46`, `update()`는 `store.js:67-84`
- **정정(핵심):** `allStudents`는 `app.js:154`(init)·`app.js:563`(renderStudents 재대입) 두 곳에서만 재대입되고 **직후 `storeUpdate({ allStudents })`**(`app.js:570`). 즉 `state.allStudents`와 지역 `allStudents`는 **같은 배열 참조(alias)**. 이후 in-place 변경(`push`/`sort`/`[idx]=`)은 store를 통해 그대로 보임. promo-extractor·naesin-schedule·past-history는 `state.allStudents`(같은 배열)를 읽으므로 **stale 위험 없음**. Codex의 "저장 후 로컬만 바뀌어 stale" 헤드라인은 `allStudents`에는 **부정확**.
- **남는 진짜 문제(저위험):** `currentStudentId`는 원시값이라 store가 복사본 보유. 미러 누락 경로: `app.js:2147`(showNewStudentForm), `app.js:2742`(신규저장 분기), `app.js:5292`(confirmBulkDelete) — `storeUpdate` 없이 지역만 null/대입. past-history의 "학생 전환됨" 가드(`past-history.js:282,309,380`)가 stale 볼 수 있으나 영향은 경미.
- 재평가: **High → Low/Medium**. (단 "store를 SSoT로" 방향성은 유효 — 원시값 미러 누락만 정리.)

### H-04. 학생 저장·이력 부분 성공(비원자성) — **CONFIRMED**
- 현재 위치: `app.js:2577-2629`(편집 분기: `setDoc(...students...)` 후 별도 `Promise.all`로 history addDoc), `app.js:2682-2704`(기존학생 생성 분기), `app.js:2730-2740`(신규 분기). 모두 writeBatch/transaction 아님.
- 검증: 편집 분기는 학생 setDoc 성공 후 history addDoc 실패 가능 → 학생은 이미 변경됐는데 catch(`app.js:2762`)가 "저장 실패" 표시. 정확.

### H-05. 내신 기간 동기화 오류 정상 종료 — **CONFIRMED (단 Med로 하향)**
- 현재 위치: `functions/index.js:145`(`retry:false`), `:156` syncNaesinPeriod 호출, `:158-160` catch 후 로그만(재전파 안 함). Codex 144-162 정확.
- 검증: 정확. 다만 **수동 oneoff 복구 경로가 주석으로 명시**돼 있고(`:160`), 현실 실패는 부분 청크. "영구 divergence"는 다소 과장. 동일 파일 다른 트리거는 모두 재전파(`:34-37,52-55,72-75`, `onLeaveRequestApproved`는 `retry:true`) — 이 트리거만 의도적 이탈.
- 재평가: **High → Medium**. 권장: `class_settings`에 `naesin_sync_error` 마커 기록(`finalize_error` 패턴 `index.js:130-133` 미러).

### H-06. 검증 없는 Functions 자동 배포 — **CONFIRMED**
- 현재 위치: `.github/workflows/deploy-functions.yml` 단일 job `deploy`, `needs:` 없음, test/lint job 없음. 배포 스텝 `:49`(`npm install`)→`:51`(deploy shared), `:57`(`npm install`)→`:59`(deploy leave-request). package.json에 lint/test 스크립트는 있으나 미호출.
- **보강:** `firebase.json`에 `predeploy` 훅도 없음 → CLI 수동 배포도 무검증 → [N-04].

### H-07. Hosting workflow false positive — **CONFIRMED**
- 현재 위치: `.github/workflows/deploy.yml:14-19`. `curl -s -X POST .../dispatches` — `-f`/`--fail` 없음, exit code 미검사, downstream run polling 없음. 토큰 만료 시 401이어도 job 초록. 정확.

### H-08. SMS fallback 생성 실패 시 유실 — **PARTIAL (실재 버그, 표현 일부 과장)**
- 현재 위치: `functions-shared/src/queueWorker.js:258-299`. fallback `set()`(`:267-279`)과 원본 `update({status:'converted_to_sms'})`(`:283`)이 **비원자**. fallback 실패는 catch로 삼킴(`:280-282`)고 원본은 무조건 converted 처리. 원본은 콜백 안 함(`:297` 주석, `:298` return).
- **정정:** "원본·fallback 모두 미처리"는 약간 과장. 실제 손실 = **fallback SMS 조용히 누락 + 콜백 영원히 미발화**. `converted_to_sms`는 retry sweeper 쿼리(`:324-346`, `failed_retryable|processing`만) 대상 아님 → 영구 유실. 행복 경로(set 성공)는 새 `direct` 문서가 onMessageQueued 재트리거로 정상 처리됨.
- 재평가: **Medium-High** (set이 실제로 throw해야 발생 — 드물지만 발생 시 무성 유실).

## MEDIUM

### M-01. 성적 요약 삭제 오류 무시 — **CONFIRMED**
- 현재 위치: `functions/src/syncStudentScores.js:52`(external delete `.catch(()=>{})`), `:70`(academy delete `.catch(()=>{})`). 트리거 `onExternalScoreWritten`(`:82`)·`onResultScoreWritten`(`:91`) 모두 `retry:false`.
- 검증: 정확. **NOT_FOUND만 멱등 성공으로 삼키고 나머지(PERMISSION_DENIED/UNAVAILABLE/DEADLINE 등)는 재전파**가 맞음(Codex 질문에 대한 답). 보강: set 분기(`:56-59,74-77`)는 `.catch` 자체가 없어 실패가 무로그로 dropped — 4개 경로 에러 처리 비일관.

### M-02. 백필 기본 실행 모드 — **CONFIRMED (Med→Low 경향)**
- 현재 위치: `functions/backfill-student-scores.mjs:8`(projectId 'impact7db' 하드코딩), `:10`(`DRY = argv.includes('--dry')`). 기본 execute, 확인 프롬프트/`--yes`/emulator 가드 없음.
- 검증: 정확. 다만 write는 merge·멱등이고 소스는 read-only라 실손해는 작음. 권장: dry 기본 + `--execute` 명시.

### M-03. 광역 Functions deploy script — **CONFIRMED (Low)**
- 현재 위치: `functions/package.json:11` `"deploy": "firebase deploy --only functions"` → 두 codebase 모두 배포. AGENTS.md 경고와 충돌. 권장: `--only functions:leave-request`.

### M-04. 일괄 작업 부분 성공 처리 — **CONFIRMED (단 예시 1건 INACCURATE)**
- 확인된 패턴(루프 내부 commit, 로컬 동기화는 루프 후 1회 → 중간 청크 실패 시 앞 청크 커밋됐는데 catch로 전체 실패·로컬 미반영):
  - `applyBulkStatus` 루프 `app.js:4820-4833`, 동기화 `:4835`(catch `:4840`)
  - `applyBulkClass` `app.js:4922-4943`
  - `applyBulkDays` `app.js:5004-5026`
  - `applyBulkPromotion` `app.js:5115-5128`
  - `confirmBulkDelete` `app.js:5266-5287`
  - `confirmEndClass` `app.js:3472-3511`
- **정정:** Codex가 든 `naesin-schedule.js:345`는 **버그 아님** — 동기화가 루프 **내부**(`naesin-schedule.js:386-391`)라 커밋된 청크는 로컬 반영됨(안전 패턴). 오히려 [N-08]: 문법특강(`app.js:6398-6483`)은 commit **전** 로컬 변경(`:6440-6444,6467`) → 실패 시 phantom 로컬 상태(over-sync).

### M-05. 상태 변경 vs enrollment 정합성 — **CONFIRMED (표현 일부 과장)**
- 현재 위치: rule `enrollmentStatusConsistent()` `firestore.rules:104-107`(create `:113`, update `:120` 강제). 위반 경로: `applyBulkStatus`(`app.js:4824` status만), `confirmBulkDelete`(`app.js:5270-5273` status='퇴원'만, enrollment 미정리). 둘 다 `reconcileEnrollments` 미사용.
- **정정:** `applyBulkStatus` 드롭다운은 `퇴원`만 비재원 상태로 선택 가능(index.html:446) — "종강/상담"은 이 경로에선 도달 불가(과장). 올바른 패턴은 `confirmEndClass`(`app.js:3478-3489`, remaining==0일 때만 퇴원/종강).
- 재평가: Medium (enrollment 보유 학생 포함 시 batch 전체 거부 → 실사용 장애 가능, 상향 여지).

### M-06. `@impact7/shared` 버전 drift — **CONFIRMED**
- 확인된 실제 버전: 루트 `package.json` v1.30.0, `functions-shared/package.json` v1.30.0, `functions/package.json` **v1.28.0**(2버전 뒤). `scripts/check-shared-lock-sync.mjs:5-12`는 CWD 한 곳의 spec↔lock만 검사 → 패키지 간 버전 패리티 미보장.
- **보강:** 근본 원인은 [N-03] — `update-shared.yml:26-33`이 루트 package.json만 bump.

### M-07. 재현 불가 Functions 의존성 — **CONFIRMED (정정 포함)**
- 확인: `git ls-files` 결과 추적 lockfile은 **루트만**. `functions/`·`functions-shared/` lockfile 미추적. `.gitignore:17`은 **앵커 없는 `package-lock.json`**(모든 depth ignore). 루트 lockfile은 force-add로 생존. 워크플로는 `npm install`(`:49,57`) 사용(`npm ci` 아님).
- **정정:** 진짜 버그는 "functions lockfile 누락"이 아니라 **`.gitignore` 규칙이 너무 광범위(`package-lock.json` 전역)**. 수정은 규칙을 경로 한정하고 functions lockfile 추적 + `npm ci`.

### M-08. 테스트 격리·계약 drift — **CONFIRMED (전 항목, 실측)**
- 통합 테스트 공유 projectId `impact7db-test` + 동일 컬렉션 병렬 삭제: `functions/test/finalize.integration.test.js:10-11/21`, `syncNaesinPeriod.integration.test.js:10-11/20`, `syncStudentScores.integration.test.js:10-11/20`. `students` 3파일 공유. functions에 vitest 병렬 차단 설정 없음.
- 계약 drift(실제 실행 확인): `student-label-sync.test.js:7,15`가 폐기된 `school` 미러 기대(구현 `studentLabelSync.js:4,9-12`는 중단) → 2 fail. `attendanceState.test.js:40,61`이 구 라벨 `복귀` 기대(현 계약 `귀원`, `attendanceState.js:10,14`) → fail. `chatSyncHandler.test.js:82`가 고정 2026-06-12 fixture vs now()-3d 커서(`chatSyncHandler.js:14-18`) → fail.
- `attendanceState.test.js`는 `functions-shared/vitest.config.js:7`에서 exclude — 다만 `node:test`용이라 vitest가 못 돌림. **보강:** `node --test`로 돌리는 스크립트가 어디에도 없어 **완전 고아**(단순 exclude보다 나쁨).
- Storage rules 테스트 0건, root `test:rules` 스크립트 없음(rules 테스트가 순수 테스트와 혼재, emulator 수동 필요), `firebase.json`에 `emulators` 블록 없음.
- audit 재실행(`--omit=dev`) **정확히 일치**: root 1/1/1, functions 0/4/12/1, functions-shared 0/2/9/0.

## 유지보수·운용

### O-01. 깨진 npm script — **CONFIRMED**
- `package.json:18-19` `migrate:label`/`migrate:label:run`이 `migrate-school-label.js` 실행하나 파일 없음(disk·git 모두) → MODULE_NOT_FOUND. Low.

### O-02. 폐기 `school` 미러 재생성 — **CONFIRMED**
- `migrate-school-by-level.js:24-25` `currentSchool(merged)` 계산 후 `update.school` 기록. Admin SDK(`:8,38`)라 rules 우회. school을 진짜 드롭할 거면 이 스크립트가 되살림. Low-Medium.

### O-03. 중복 help guide — **CONFIRMED (실제로 더 나쁨: 양방향 분기)**
- `help-guide.js`(683줄)·`public/help-guide.js`(689줄) 둘 다 git 추적, MD5 상이. `index.html:1194` `<script src="help-guide.js">`(루트 로드), Vite는 `public/` 사본을 `/help-guide.js`로 서빙(배포 시 그쪽이 우선).
- **정정:** 단순 stale 사본이 아니라 **양방향 fork** — `public/`엔 초성검색+상태필터 수정+포커스트랩, 루트엔 모달 통합 리라이트+초성검색 제거. 각자 상대에 없는 변경 보유. Medium.

### O-04. 학생 문서 필드 제한 — **CONFIRMED (과소평가 → Med 상향)**
- 확인: 허용 필드 목록 `firestore.rules:78-96` = **48개**, create/update는 `withinFieldLimit(36)`(`:112,118`). 36개 초과 정상 문서는 저장 거부.
- **재평가:** 단순 ops가 아니라 **조용한 저장 거부 리스크**(메모리 feedback_student_field_rules_sync: 과거 silent reject 실사고). 장기재원·이력누적 학생은 36 근접 가능. → Medium. 액션: 운영 데이터에서 실제 최대 필드수 측정 후 한도 상향 또는 허용목록 정리.

### O-05. 성능 — **PARTIAL (비모듈 사실, 청크/경고 미검증·과장)**
- 확인: `help-guide.js`는 `index.html:1194`에서 `type="module"` 없이 로드(IIFE, import/export 0). → Vite가 번들 안 함(정적 자산 복사).
- **정정:** 비모듈 정적 자산이라 **"메인 청크에 들어가 번들 경고" 메커니즘은 틀림**. ~625KB 수치는 빌드 미실행으로 미검증. Low.

---

## 신규 발견 (Codex 누락)

| ID | 내용 | 위치 | 등급 |
|----|------|------|------|
| **N-01** | `exam_analyses` read가 `request.auth != null`(도메인 미검증) → 외부 Firebase 계정이 내신분석자료 전체 read·자기 createdBy로 create. `exam_users` read도 `isLoggedIn()` 동일 노출(C-01 외부화) | `firestore.rules:1165-1167`, `:199` | **HIGH** |
| **N-02** | C-02+C-03 결합 익스플로잇 체인: 공개 토큰 list로 staffId/contractId 수집 → 공개 get으로 전 직원 PII 일괄 유출(ID 추측 불요) | rules 779~1045 | **CRITICAL(증폭)** |
| **N-03** | `update-shared.yml`이 루트 package.json만 bump, functions/functions-shared 미갱신 → M-06 drift의 근본 원인 | `.github/workflows/update-shared.yml:26-33` | MEDIUM |
| **N-04** | `firebase.json`에 `predeploy` 훅 없음 → 수동 `firebase deploy`도 무검증(H-06 보강) | `firebase.json` functions 블록 | LOW |
| **N-05** | 전 callable `enforceAppCheck:false` → 토큰만 있으면 호출. H-02의 시스템적 근본 | `functions-shared/index.js` 다수 onCall | MEDIUM |
| **N-06** | `syncNaesinPeriod` history_logs가 class_settings 변경과 비원자 + 청크 부분 실패 무롤백(재시도 없음, H-05와 결합) | `functions/src/syncNaesinPeriod.js:64-80` | MEDIUM |
| **N-07** | 일괄 퇴원(`confirmBulkDelete`)이 단일저장(`app.js:2563-2565`)이 쓰는 `status_changed_at`/`status_previous` audit 메타 미기록 → 상태변경 감사 추적 공백 | `app.js:5270-5273` | MEDIUM |
| **N-08** | 문법특강이 `batch.commit()` 전에 로컬 `allStudents` 변경 → 실패 시 phantom 로컬 상태(M-04 역방향) | `app.js:6440-6444,6467,6483` | MEDIUM |
| **N-09** | `paymentHook` public + 서명검증 없음(현재 stub 503). 구현 시점에 즉시 HIGH | `functions-shared/index.js` paymentHook | LOW(현재)/HIGH(구현시) |
| **N-10** | 통합 테스트 emulator host/port(`127.0.0.1:8080`) 하드코딩 + `firebase.json` emulators 블록 없음 → `npm test`가 기본 환경에서 부분 실패 | `functions/test/*.integration.test.js`, root `tests/firestore.rules.*` | LOW |

## 종합 판정

- Codex 발견 **25건 중 23건 CONFIRMED**, 2건 PARTIAL(H-03 과대·H-08 과대), 예시 1건 INACCURATE(M-04의 naesin:345).
- 보안 P0(C-01~C-03, H-01, H-02)는 **전부 정확**하며 N-01·N-02로 **오히려 더 심각**.
- 신규 10건 추가. 최종 판정 **REQUEST CHANGES** 유지.
