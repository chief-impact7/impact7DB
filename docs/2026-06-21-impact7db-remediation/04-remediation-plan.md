# 권장 수정 계획 (검증·보정본)

각 작업 끝에 finding ID를 표기한다. 재평가로 우선순위가 바뀐 항목은 ⚠로 표시.
**소스 변경 커밋 전 `simplify` → `code-review` → quality guard marker** 필수(문서/JSON/lock 변경은 제외).

## ⚠ 크로스앱 선결 조건 (Phase 1 진입 전 필독)

C-02·C-03·H-01 수정(공개 토큰 read·직원/계약 get·Storage HR 경로 차단)은 **HR 앱(별도 repo)의 비인증 온보딩/서명/업로드 플로우를 깨뜨린다.** 순서를 지켜야 한다.

1. HR 앱의 공개 read 의존 플로우 식별(온보딩 토큰 검증, 계약 서명 페이지, 급여약정, 단기직 등록, Storage 업로드/다운로드).
2. 그 플로우를 **callable/HTTP backend 경유로 먼저 이전**(`functions-shared`에 토큰검증 callable 추가).
3. 이전·검증 완료 후 이 repo에서 rules의 `read: if true`/`get: if true`를 제거.
4. firestore.rules는 이 repo가 SSoT이므로, 변경 후 `firestore-rules-sync` 스킬로 4-repo 동기화. storage.rules도 동일(이 repo SSoT).

> 단독으로 rules만 닫으면 HR 운영 장애. `impact7-orchestrator`로 DB·HR·functions를 함께 조율한다.

## Phase 1. 보안 차단

### 목표
비인증/외부도메인/권한 없는 사용자가 토큰·HR PII·계약·Storage·AI 비용에 접근하지 못한다.

### 작업
1. `exam_users` 자기 수정 allowlist + `role` 서버 전용 + read/write를 `isAuthorized()`로. [C-01]
2. `exam_analyses` read/create/update를 `isAuthorized()`로. [N-01]
3. 공개 토큰 `read: if true` 6곳 제거 + 토큰 검증 callable + 1회 소비 transaction. [C-02·N-02] ⚠선결조건
4. 직원/계약 공개 `get: if true` 4곳 제거 + 마스킹 callable. [C-03·N-02] ⚠선결조건
5. Storage 경로별 역할·소유권·MIME·크기 제한. [H-01] ⚠선결조건
6. `llmGenerate`에 `assertAuthorizedStaff()` + per-uid rate limit. [H-02]
7. 비용 발생 callable App Check 단계 도입. [N-05]
8. 해당 Firestore/Storage rules emulator 회귀 테스트(취약→통과 순). [06-test-writing-guide]

### 완료 기준
- 비인증 list/get 모두 거부, 외부 도메인 계정 거부.
- 유효 대상 토큰만 1회 사용.
- 일반 직원이 타인 계약/서명 read/write 불가.
- 외부 Firebase 사용자의 AI 호출 거부, callable App Check 통과 필요.

## Phase 2. 배포 게이트

### 작업
1. functions/functions-shared lockfile 추적(`.gitignore` 규칙 경로 한정) + `npm ci`. [M-07]
2. codebase별 validate job(lint/unit/emulator/import smoke). [H-06]
3. `firebase.json` predeploy 훅 추가. [N-04]
4. emulator 통합 테스트 격리(고유 projectId/namespace 또는 직렬). [M-08·N-10]
5. `deploy` job에 `needs: validate`. [H-06]
6. 광역 deploy 스크립트 `--only functions:leave-request` 고정. [M-03]
7. Hosting dispatch `curl --fail-with-body` + downstream run 추적. [H-07]
8. `master` branch protection + required checks.

### 완료 기준
- 테스트 실패 시 운영 deploy 미실행.
- 같은 SHA는 동일 dependency tree로 배포.
- 초록 Hosting workflow가 실제 downstream 성공을 의미.

## Phase 3. 데이터 정합성

### 작업
1. 학생 저장 + 필수 history를 atomic write(writeBatch/transaction). [H-04]
2. 일괄 상태/퇴원에 `reconcileEnrollments()` 적용 + status 메타(`status_changed_*`/`status_previous`) + STATUS_CHANGE history. [M-05·N-07]
3. 내신/성적 trigger 멱등화 후 오류 재전파 + retry/마커, NOT_FOUND만 삼킴. [H-05·M-01·N-06]
4. SMS fallback 전환 atomic화, 실패 시 원본 retryable 유지. [H-08]
5. 다중 batch 부분 성공 기록·성공 청크만 로컬 반영·재시도 ID. [M-04]
6. 문법특강 로컬 동기화를 commit 성공 후로 이동. [N-08]
7. `currentStudentId` store 미러 누락 정리. [H-03]

### 완료 기준
- student/history가 한쪽만 저장되지 않음.
- 모든 저장 경로에서 status↔enrollments 동일 계약.
- trigger 실패가 성공으로 은폐되지 않음.
- 일괄 작업 실패 시 정확한 성공/실패 건수 표시.

## Phase 4. 상태·shared 계약 정리

### 작업
1. 직접 mutation을 `storeUpdate()`로(원시값 포함). [H-03]
2. root/functions/functions-shared shared 버전 통일. [M-06]
3. `update-shared.yml`이 3개 package.json 모두 bump. [N-03]
4. subpackage lock/version guard 확장. [M-06]
5. `app.js` 수정 대상 블록을 모듈 분리 규칙대로 점진 분리(AGENTS.md 규칙).

### 완료 기준
- 저장 직후 모든 모듈 동일 학생 데이터.
- 세 package 동일 shared 계약.

## Phase 5. 운용 정리

1. 깨진 `migrate:label` 스크립트 제거. [O-01]
2. `migrate-school-by-level.js` school 미러 write 제거. [O-02]
3. `help-guide.js` 양방향 fork 병합 후 정본 단일화. [O-03]
4. 백필 dry 기본화 + `--execute` 명시. [M-02]
5. 학생 필드 36 한도 재검토(운영 데이터 실측). [O-04]
6. dependency audit runtime 도달성 분석·업데이트. [감사 수치]
7. rollback workflow + post-deploy smoke test 추가.
8. Storage rules 테스트 + `test:rules` 스크립트 + `firebase.json` emulators 블록. [M-08·N-10]

## 권장 커밋 분리

1. `security: close public HR/exam privilege paths and external-domain access` [C-01~03,N-01,N-02,H-01,H-02,N-05]
2. `ci: gate production deploys on deterministic validation` [H-06,H-07,M-07,N-03,N-04]
3. `reliability: make student/trigger/sms writes atomic and idempotent` [H-04,H-05,M-01,H-08,N-06,N-07,N-08]
4. `architecture: make store and shared contracts authoritative` [H-03,M-04,M-05,M-06]
5. `maintenance: remove stale scripts, dedupe assets, fix field limit` [O-01~05]
6. `test: isolate integration tests, refresh contract fixtures, add rules coverage` [M-08,N-10]

각 소스 코드 커밋 전 `simplify` → `code-review` 수행 후 staged quality marker 기록:
`node /Users/jongsooyi/IMPACT7/impact7DB/.agents/hooks/impact7-precommit-quality-guard.mjs --mark`

## 진행 원칙

- P0 보안·CI 먼저. 보안은 ⚠크로스앱 선결조건 준수.
- 각 finding: 회귀 테스트(취약 동작에서 실패) → 최소 수정 → 통과 확인 → 증거·잔존위험 기록.
- 대량 배치 Firestore 작업은 사용자 승인 후(메모리 feedback_no_autonomous_batch).
- 운영 배포는 사용자 요청 시에만. commit/push도 사용자 요청 전 금지.
