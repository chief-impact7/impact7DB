# 상세 발견사항 (검증·정정·보완본)

라인 번호는 **현재 파일 기준**. 각 항목 끝에 재검증 판정을 표기한다.
판정 약어: `CONFIRMED`(정확) · `PARTIAL`(부분/과대·과소) · `INACCURATE`(세부 오류).

## CRITICAL

### C-01. `exam_users` 자기 권한 상승 — CONFIRMED
- 위치: `firestore.rules:198-203`
- 현상: 로그인 사용자가 자기 `exam_users/{uid}` 문서 전체를 write → `role:'owner'` 자가 설정 → 이후 owner 조건으로 타인 문서 수정.
- **보강:** `allow read: if isLoggedIn()`(`:199`)·write 조건의 `isLoggedIn()`은 **도메인 미검증**(`request.auth != null`). 조직 정책 완화로 **외부 구글 계정도** 토큰 획득 가능 → 외부 공격자 owner 승격. ([N-01]과 동일 뿌리)
- 권장:
  - 자기 수정은 표시명 등 명시 필드만 allowlist.
  - `role`은 Admin SDK/custom claim/관리자 전용 서버 경로에서만.
  - read/write 조건을 `isAuthorized()`(도메인)로 강화.

### C-02. 비인증 HR 토큰 list/get — CONFIRMED
- 위치(6개, 모두 `allow read: if true`): `firestore.rules:784`(onboardingTokens), `:801`(contractSigningTokens), `:818`(salaryAgreementTokens), `:864`(shortTermTokens), `:995`(employeeOnboardingTokens), `:1009`(employeeContractSigningTokens)
- 현상: `read: if true`는 단건 get + 컬렉션 list 모두 허용 → 온보딩/서명/급여/단기직 토큰 수집·재사용.
- 권장:
  - 클라 토큰 컬렉션 read 차단.
  - callable/HTTP backend가 토큰 1건만 검증, 최소 결과 반환.
  - 토큰을 대상 이메일·직원·계약에 바인딩, transaction 1회 소비.

### C-03. 직원 개인정보·계약서 비인증 get — CONFIRMED
- 위치: `firestore.rules:889`(staff get), `:897`(staff contracts get), `:1030`(employees get), `:1036`(employees contracts get) — 모두 `allow get: if true`
- 현상: 문서 ID를 알면 주민번호·주소·계좌·세무·급여·서명 노출. (`get`만 허용 → `list` 불가, ID 필요)
- 권장: 공개 get 제거, 토큰 검증 서버가 마스킹 최소정보만 반환.

### N-02. 토큰→PII 익스플로잇 체인 — CRITICAL (신규)
- 결합: C-02의 공개 토큰 컬렉션을 **list로 전부 긁어** 토큰 문서의 `staffId`/`contractId` 수집(`firestore.rules:786` update 허용필드, `:904` contractId 참조) → 그 ID로 C-03의 공개 `get` 호출 → **ID 추측 없이 전 직원 PII 일괄 유출**.
- 의미: C-02·C-03은 독립 결함이 아니라 결합 시 완전 PII 유출 경로. 둘을 함께 닫아야 함.

## HIGH

### H-01. Storage가 HR 역할·소유권 우회 — CONFIRMED
- 위치: `storage.rules:12-38`
- 현상: `exam-papers`/`scans`/`staff`/`contracts`/`expenses`/`signatures` 모두 `isAuthorized()`(도메인뿐). impact7 직원(단기직 포함)이 모든 HR 계약·서명·경비 read/write. HR 경로엔 크기·MIME 제한 없음(student-records만 `:44-46`).
- 권장: 경로별 read/create/update/delete 분리 + Firestore HR 역할·소유권 검사 + 전 경로 크기·MIME allowlist.

### N-01. 외부 도메인 계정의 exam_analyses/exam_users 접근 — HIGH (신규)
- 위치: `firestore.rules:1165-1167`(exam_analyses), `:199`(exam_users)
- 현상: `exam_analyses` read `if request.auth != null`, create `createdBy==uid`만 — **도메인 미검증**. 외부 Firebase 계정이 내신분석자료 전체 read + 자기 문서 create. `exam_users` read도 `isLoggedIn()`로 동일.
- 권장: 두 컬렉션 read/create/update를 `isAuthorized()`(도메인)로 전환.

### H-02. `llmGenerate` 비용 악용 — CONFIRMED
- 위치: `functions-shared/src/llmHandler.js:36-39`
- 현상: `if (!request.auth)`만 검사. `assertAuthorizedStaff()`/`isAuthorizedStaffEmail()`(`authGuards.js:5-17`) 미적용. rate limit/quota/App Check 없음.
- 보강: 전 callable 중 **llmGenerate만 도메인 미검증**(나머지는 `assertAuthorizedStaff` 적용). studentReportAi/batch는 staff-gated이나 quota 없음.
- 권장: `assertAuthorizedStaff(request.auth)` 적용 + per-uid rate limit + App Check.

### N-05. 전 callable App Check 부재 — MEDIUM (신규)
- 위치: `functions-shared/index.js`의 모든 `onCall({ enforceAppCheck:false })`
- 현상: App Check 미강제 → 가드된 callable도 bare Firebase 토큰만 신뢰. H-02의 시스템적 근본.
- 권장: 단계적 App Check 도입(우선 비용 발생 callable부터).

### H-03. `app.js`↔`store.js` 상태 분리 — PARTIAL (과대 → Low/Medium)
- 위치: `app.js:153-156`, `store.js:28-46/67-84`, `app.js:2147/2742/5292`, `past-history.js:282/309/380`
- **정정:** `allStudents`는 `state.allStudents`와 **같은 배열 참조(alias)** — `app.js:154/563` 재대입 직후 `storeUpdate`(`:570`), 이후 in-place 변경은 store로 그대로 보임. 형제 모듈 stale 위험 없음.
- 남는 문제(저위험): `currentStudentId`(원시값) 미러 누락 — `app.js:2147`(신규폼), `:2742`(신규저장), `:5292`(일괄삭제)에서 `storeUpdate` 없이 지역만 변경.
- 권장: 원시 상태 변경도 `storeUpdate()` 경유로 통일(방향성은 유효, 위험은 낮음).

### H-04. 학생 저장·이력 비원자성 — CONFIRMED
- 위치: `app.js:2577-2629`(편집: setDoc 후 별도 Promise.all history), `:2682-2704`, `:2730-2740`
- 현상: 학생 문서와 history를 별도 write → 학생 저장 후 history 실패 가능, UI는 "저장 실패" 표시(`:2762`)지만 학생은 이미 변경.
- 권장: 학생 변경 + 필수 audit log를 같은 writeBatch/transaction.

### H-05. 내신 기간 동기화 오류 정상 종료 — CONFIRMED (High→Medium)
- 위치: `functions/index.js:145`(retry:false), `:156`, `:158-160`(catch 후 로그만)
- 현상: syncNaesinPeriod 오류를 삼킴 → class_settings와 학생 enrollment 기간 divergence 가능.
- 보정: 수동 oneoff 복구 경로 주석 존재(`:160`), 현실 실패는 부분 청크 → "영구 divergence"는 과장. 동일 파일 다른 트리거는 모두 재전파.
- 권장: 멱등 보장 후 재전파 + `naesin_sync_error` 마커(`finalize_error` 패턴 `:130-133` 미러).

### N-06. syncNaesinPeriod history_logs 비원자·무롤백 — MEDIUM (신규)
- 위치: `functions/src/syncNaesinPeriod.js:64-80`
- 현상: class_settings 변경(트리거 원인, 이미 커밋)과 student+log batch는 별도 트랜잭션, 청크 부분 실패 시 일부만 동기화·롤백 없음. H-05의 retry 부재와 결합 시 영구 부분 divergence.
- 권장: 멱등(end_date 동일 시 skip `:52`은 이미 멱등) + 마커/재시도. 대용량 시 override 필터를 쿼리로 푸시(현재 in-memory `:38-43`).

### H-06. 검증 없는 Functions 자동 배포 — CONFIRMED
- 위치: `.github/workflows/deploy-functions.yml`(단일 job, `needs:` 없음, `:49/51/57/59` install→deploy)
- 현상: test/lint/build 게이트 없이 master push로 운영 배포.
- 권장: validate job(lint/unit/emulator/import smoke) + deploy `needs: validate`.

### N-04. firebase.json predeploy 훅 없음 — LOW (신규)
- 위치: `firebase.json` functions 블록
- 현상: predeploy 없음 → 수동 `firebase deploy`도 무검증. H-06 보강.
- 권장: predeploy에 lint/test 추가.

### H-07. Hosting workflow false positive — CONFIRMED
- 위치: `.github/workflows/deploy.yml:14-19`
- 현상: `curl -s`가 HTTP 오류를 실패 처리 안 함, downstream 통합 배포 완료를 안 기다림.
- 권장: `curl --fail-with-body` + downstream run ID 추적.

### H-08. SMS fallback 생성 실패 시 유실 — PARTIAL (Medium-High)
- 위치: `functions-shared/src/queueWorker.js:258-299`
- 현상: fallback `set()`(`:267-279`)과 원본 `converted_to_sms` 처리(`:283`)가 비원자. fallback 실패를 catch로 삼킴(`:280-282`)고 원본 종결, 원본은 콜백 안 함(`:297-298`).
- 정정: "원본·fallback 모두 미처리"는 과장. 실제 = fallback SMS 무성 누락 + 콜백 영구 미발화 + retry sweeper(`:324-346`) 대상 아님.
- 권장: fallback 생성 + 원본 상태 변경을 transaction/batch, 실패 시 원본 retryable 유지.

## MEDIUM

### M-01. 성적 요약 삭제 오류 무시 — CONFIRMED
- 위치: `functions/src/syncStudentScores.js:52,70`(delete `.catch(()=>{})`), 트리거 `:82,91` retry:false
- 현상: 삭제 update 오류 전부 삼킴 → 삭제 성적이 `student_scores`에 잔존.
- 보강: set 분기(`:56-59,74-77`)는 `.catch` 없어 무로그 dropped — 에러 처리 비일관.
- 권장: NOT_FOUND만 멱등 성공, 나머지 재전파. 또는 존재 가드/merge로 NOT_FOUND 제거.

### M-02. 백필 기본 실행 모드 — CONFIRMED (Low 경향)
- 위치: `functions/backfill-student-scores.mjs:8,10`
- 현상: `--dry` 없으면 운영 즉시 write. 가드 없음. (merge·멱등·read-only 소스라 실손해는 작음)
- 권장: dry 기본 + `--execute --project impact7db` 이중 명시.

### M-03. 광역 Functions deploy script — CONFIRMED (Low)
- 위치: `functions/package.json:11` `firebase deploy --only functions`(두 codebase 배포)
- 권장: `--only functions:leave-request --project impact7db` 고정.

### M-04. 일괄 작업 부분 성공 처리 — CONFIRMED (예시 1건 INACCURATE)
- 위치(루프 후 1회 동기화 → 부분 커밋·로컬 미반영·전체 실패 표시): `app.js:3472-3511`(confirmEndClass), `:4217`(loop), `:4820-4840`(applyBulkStatus), `:4922-4943`(applyBulkClass), `:5004-5026`(applyBulkDays), `:5115-5128`(applyBulkPromotion), `:5266-5287`(confirmBulkDelete)
- **정정:** `naesin-schedule.js:345`는 동기화가 루프 내부(`:386-391`)라 **안전 패턴**(버그 아님).
- 권장: 청크별 성공 ID 기록, 성공 건만 로컬 반영, 재시도 가능한 operation ID.

### N-08. 문법특강 phantom 로컬 상태 — MEDIUM (신규)
- 위치: `app.js:6440-6444,6467`(commit 전 로컬 변경), `:6483`(commit)
- 현상: `batch.commit()` 실패 시 커밋 안 된 학생/enrollment가 로컬에 남음(over-sync). M-04의 역방향.
- 권장: commit 성공 후 로컬 반영으로 순서 교정.

### M-05. 상태 변경 vs enrollment 정합성 — CONFIRMED (표현 일부 과장)
- 위치: rule `firestore.rules:104-107`(create `:113`/update `:120`), `app.js:4824`(applyBulkStatus), `:5270-5273`(confirmBulkDelete)
- 현상: 일괄 퇴원이 status만 변경·enrollment 유지 → enrollment 보유 학생은 rule이 batch 전체 거부.
- 정정: applyBulkStatus 드롭다운은 `퇴원`만 비재원(종강/상담 도달 불가). 올바른 패턴은 `confirmEndClass`(`:3478-3489`).
- 권장: 공유 `reconcileEnrollments()`로 enrollment 정리 + 상태 + audit를 한 batch.

### N-07. 일괄 퇴원 status 메타 누락 — MEDIUM (신규)
- 위치: `app.js:5270-5273` vs 단일저장 `:2563-2565`
- 현상: `confirmBulkDelete`가 단일저장이 쓰는 `status_changed_at`/`status_changed_by`/`status_previous` 미기록 → 상태변경 감사 추적 공백.
- 권장: 일괄 경로도 상태 메타 + STATUS_CHANGE history 기록.

### M-06. `@impact7/shared` 버전 drift — CONFIRMED
- 위치: 루트 `package.json:28` v1.30.0, `functions-shared/package.json:14` v1.30.0, `functions/package.json:15` **v1.28.0**. `scripts/check-shared-lock-sync.mjs:5-12`는 CWD 한 곳만 검사.
- 권장: 3패키지 버전 통일 + subpackage까지 guard.

### N-03. update-shared.yml 루트만 bump — MEDIUM (신규)
- 위치: `.github/workflows/update-shared.yml:26-33`
- 현상: 자동 bump가 루트 package.json/lock만 갱신, functions/functions-shared 미갱신 → M-06 drift의 기계적 원인.
- 권장: 워크플로가 3개 package.json 모두 bump.

### M-07. 재현 불가 Functions 의존성 — CONFIRMED (정정 포함)
- 위치: `.gitignore:17`(앵커 없는 `package-lock.json` → 전 depth ignore), `deploy-functions.yml:49,57`(`npm install`)
- 정정: 진짜 원인은 .gitignore 규칙이 너무 광범위(루트 lock은 force-add로 생존). functions/functions-shared lock 미추적.
- 권장: .gitignore 경로 한정 + functions lock 추적 + `npm ci`.

### M-08. 테스트 격리·계약 drift — CONFIRMED (실측)
- 통합 테스트 공유 projectId·컬렉션 병렬 삭제(`functions/test/*.integration.test.js:10-11/20-21`), functions 병렬차단 설정 없음.
- 계약 drift(실행 확인): `student-label-sync.test.js:7,15`(폐기 school 미러 기대) 2 fail, `attendanceState.test.js:40,61`(구 `복귀` 기대, 현 `귀원`) fail, `chatSyncHandler.test.js:82`(고정 fixture vs now()-3d 커서) fail.
- `attendanceState.test.js` exclude(`vitest.config.js:7`)+`node:test`용이라 실행 스크립트 부재 → 완전 고아.
- Storage rules 테스트 0건, root `test:rules` 없음, `firebase.json` emulators 블록 없음.
- 권장: 격리(고유 projectId/namespace 또는 직렬), 계약 fixture 갱신, clock injection, Storage rules 테스트 추가, `test:rules`/`emulators` 정비.

### N-10. emulator 설정 부재 — LOW (신규)
- 위치: `functions/test/*.integration.test.js`(host `127.0.0.1:8080` 하드코딩), `firebase.json`(emulators 블록 없음)
- 현상: `npm test`가 기본 환경(emulator 미기동)에서 부분 실패, 수동 prereq 미문서화.
- 권장: `firebase.json` emulators 블록 + `emulators:exec` 래퍼 스크립트.

## 유지보수·운용

### O-01. 깨진 npm script — CONFIRMED
- `package.json:18-19` `migrate:label*`이 없는 `migrate-school-label.js` 실행 → MODULE_NOT_FOUND.

### O-02. 폐기 school 미러 재생성 — CONFIRMED
- `migrate-school-by-level.js:24-25` Admin SDK로 `school` 재기록(rules 우회).

### O-03. 중복 help guide — CONFIRMED (양방향 fork)
- `help-guide.js`(683줄)·`public/help-guide.js`(689줄) MD5 상이, `index.html:1194`는 루트 로드·Vite는 public 서빙. 각자 상대에 없는 변경(초성검색/모달 리라이트) 보유.

### O-04. 학생 문서 필드 제한 — CONFIRMED (Med 상향)
- 허용 목록 `firestore.rules:78-96` 48개 vs `withinFieldLimit(36)`(`:112,118`). 36 초과 정상 문서 저장 거부(조용한 reject 리스크).
- 액션: 운영 데이터 실제 최대 필드수 측정 후 한도 상향/허용목록 정리.

### O-05. 성능 — PARTIAL
- `help-guide.js` 비모듈 로드(`index.html:1194`, IIFE) 확인. 다만 비번들 정적 자산이라 "메인 청크 번들 경고"는 메커니즘 오류, ~625KB는 미검증.

### N-09. paymentHook public·무서명 — LOW(현재)/HIGH(구현시) (신규)
- 위치: `functions-shared/index.js` paymentHook(public, 현재 stub 503)
- 권장: 실 구현 전 서명검증·멱등 필수 설계.
