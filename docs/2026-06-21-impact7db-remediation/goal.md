# Ultragoal Brief — impact7DB 종합 리뷰 수정 완주

> 이 파일은 두 용도다.
> 1) `omc ultragoal create-goals --brief-file goal.md` 입력 brief
> 2) 네이티브 `/goal` Stop-hook의 목표·정지조건 정의서
>
> 작업폴더: `docs/2026-06-21-impact7db-remediation/` (00~06 문서가 근거)
> 승인 정책(사용자 확정 2026-06-21): **끝까지 자율 진행 + 마지막 1회 "릴리스 체크포인트"**.
> 저위험 게이트(G08 읽기측정·G09 브랜치보호)는 자동. 비가역·운영 영향 작업은 마지막 단일 confirm으로 일괄.

## 목표 (objective)

`docs/2026-06-21-impact7db-remediation/`의 검증된 발견사항(C-01~C-03, H-01~H-08, M-01~M-08, O-01~O-05, N-01~N-10)을 **04-remediation-plan.md 순서대로** 수정하고, 각 finding마다 **회귀 테스트(취약 동작에서 실패 → 수정 → 통과)**로 검증한다. HR 이전 코드까지 작성·로컬 검증한 뒤, **마지막 릴리스 체크포인트(G12)에서 단 한 번 confirm 받고** 운영 배포·HR 컷오버·대량 batch·4-repo 동기화·post-deploy smoke를 일괄 실행해 완주한다.

## 스코프 경계 (반드시 준수)

- **자율 진행(승인 없이 계속):** impact7DB in-repo 전체(rules diff·functions·app.js·CI·테스트) + impact7HR repo의 callable 이전 코드 작성/로컬 테스트(브랜치, 배포 없음) + G08 읽기측정 + G09 브랜치보호.
- **마지막 단일 체크포인트(G12)에서만 실행:** 운영 배포(firebase deploy), 공개 rules 차단의 master 반영, HR 운영 컷오버, 대량 batch Firestore write, 4-repo rules sync, post-deploy smoke.
- 작업은 각 repo의 **feature 브랜치**에서. 스토리별 로컬 commit으로 체크포인트(품질 마커 포함). push는 G12 이전에도 허용(원격 백업용)하되 **배포·컷오버·대량 write는 G12 confirm 후에만**.
- 소스 변경 commit 전 `simplify` → `code-review` → quality guard marker 필수.
- shared 우선(@impact7/shared), codegraph_explore 우선, AGENTS.md·.memory/MEMORY.md 준수.

## 스토리 (ordered goals)

### G01 — Security(외부도메인·AI비용) :: 자율
exam_users 자기수정 allowlist + role 서버전용 + read/write `isAuthorized()` / exam_analyses read·create·update `isAuthorized()` / llmGenerate `assertAuthorizedStaff()` + per-uid rate limit / 비용 callable App Check.
- 근거: C-01, N-01, H-02, N-05
- DONE: exam-users·exam-analyses·llmHandler 회귀 테스트(외부도메인 거부/직원 허용) green.

### G02 — Security callable(공개 read 대체) :: 자율
functions-shared에 토큰검증 callable + 마스킹된 staff/employee 조회 callable + 단위/통합 테스트. (G03·G10의 선결 구현물.)
- 근거: C-02, C-03, N-02
- DONE: 만료/완료/대상불일치/1회소비 정확 처리 테스트 green.

### G03 — Security rules 차단 :: 자율(작성·테스트) / 반영은 G12
공개 토큰 `read: if true` 6곳 제거 + 직원/계약 `get: if true` 4곳 제거 + Storage HR 경로 역할·소유권·MIME·크기 제한 + emulator 회귀 테스트. **master 반영·배포는 G12에서.**
- 근거: C-02, C-03, N-02, H-01
- DONE: rules diff + 테스트 green(비인증/외부/타인 거부, 정상 경로 허용).

### G04 — CI 배포 게이트 :: 자율
Functions validate job(lint/unit/emulator/import smoke) + deploy `needs: validate` / firebase.json predeploy 훅 / functions·functions-shared lockfile 추적(.gitignore 경로한정)+`npm ci` / 광역 deploy 스크립트 `--only functions:leave-request` 고정 / deploy.yml `curl --fail-with-body`+downstream 추적 / update-shared.yml 3패키지 bump.
- 근거: H-06, H-07, M-03, M-07, N-03, N-04
- DONE: 워크플로 YAML 유효 + lockfile 추적 확인.

### G05 — 데이터 정합성 :: 자율
학생 저장+필수 history atomic / 일괄 상태·퇴원에 reconcileEnrollments + status_changed_* 메타 + STATUS_CHANGE history / 내신·성적 trigger 멱등·오류 재전파·NOT_FOUND만 삼킴·retry·마커 / SMS fallback atomic·실패시 retryable / 다중 batch 부분성공 기록 / 문법특강 commit 후 로컬반영.
- 근거: H-04, H-05, M-01, H-08, M-04, M-05, N-06, N-07, N-08
- DONE: 각 항목 회귀 테스트 green(부분실패·멱등·atomic 시나리오 포함).

### G06 — 상태·shared 계약 :: 자율
currentStudentId store 미러 정리(storeUpdate) / @impact7/shared 3패키지 v1.30.0 통일 / subpackage lock·version guard 확장.
- 근거: H-03, M-06
- DONE: 미러 누락 0, 3패키지 동일 버전, guard 통과.

### G07 — 운용·테스트 하네스 :: 자율
깨진 migrate:label 제거 / migrate-school-by-level.js school 미러 write 제거 / help-guide.js 양방향 fork 병합·정본 단일화 / backfill dry 기본화 / 통합테스트 격리 / 계약 fixture 갱신(school 미러·복귀→귀원·clock injection) / attendanceState.test 실행경로 편입 / Storage rules 테스트 / firebase.json emulators 블록 / root test:rules.
- 근거: O-01, O-02, O-03, M-02, M-08, N-10
- DONE: 전체 회귀 suite green(emulator 포함), 정본 자산 단일.

### G08 — 학생 필드 한도 측정 :: 자율(읽기 전용)
운영 데이터에서 실제 최대 필드수 측정(읽기만). 결과로 withinFieldLimit 한도 상향/허용목록 정리안 결정. **데이터 write는 G12 batch에 포함.**
- 근거: O-04
- DONE: 측정 리포트 + 권고 한도 산출.

### G09 — branch protection :: 자율
gh로 master required status checks + protection 설정(가역적).
- DONE: protection 활성 확인.

### G10 — HR 앱 callable 이전 코드 :: 자율(작성·로컬테스트) / 컷오버는 G12
impact7HR repo feature 브랜치에서 비인증 온보딩/서명/업로드를 G02 callable로 이전 + 로컬/emulator 테스트. **운영 컷오버·배포는 G12.**
- 근거: C-02, C-03, H-01, N-02
- DONE: HR 이전 코드 + 테스트 green, 온보딩/서명 플로우 로컬 재현.

### G11 — 릴리스 패키지 준비 :: 자율
G03 rules·functions·HR 변경의 dry-run/diff, batch 작업 읽기수 추정, post-deploy smoke 스크립트, rollback 절차를 한 증거 패키지로 정리.
- DONE: 릴리스 증거 패키지 작성(diff·테스트결과·batch추정·smoke·rollback).

### G12 — 릴리스 체크포인트 :: 사용자 confirm 1회 → 실행
G11 증거 패키지를 사용자에게 제시하고 **단일 confirm** 후 일괄 실행:
1. firebase deploy(functions:shared, functions:leave-request) — impact7DB
2. HR 운영 배포(impact7HR)
3. firestore.rules·storage.rules 운영 반영 + `firestore-rules-sync`로 4-repo 동기화
4. 승인된 대량 batch(필드한도/school 미러 정리) — dry-run 먼저 보여주고 실행
5. post-deploy smoke + 이상 시 rollback
- DONE: 운영 반영 + smoke green + 4-repo git clean.

## 정지 조건 (/goal stop condition)

1. G01~G11 전부 완료 + 로컬/emulator 회귀 테스트 green + 품질 마커.
2. G12 증거 패키지 제시 후 사용자 confirm을 받았고, confirm된 항목 실행 + post-deploy smoke green.
3. (사용자가 G12에서 보류/거부하면) G11까지 완료 상태로 정지하고 보류 사유를 ledger에 기록.

G12 confirm 전까지는 멈추지 말고 미완 자율 스토리를 계속 진행한다. **유일한 정지점은 G12 단 1회.**

## 보고 형식 (스토리 체크포인트마다)

```
스토리:
수정 finding:
변경 파일(repo별):
테스트 명령·결과(수정 전 실패 → 수정 후 통과):
품질 마커:
크로스앱 영향(HR/DSC/exam):
다음 스토리:
```

## G12 증거 패키지 형식

```
[릴리스 체크포인트 — confirm 요청]
배포 대상: impact7DB(functions/rules) + impact7HR
rules diff 요약:
HR 이전 플로우 테스트 결과:
대량 batch: 대상 컬렉션 / dry-run 결과 / 읽기·쓰기 추정 건수:
post-deploy smoke 항목:
rollback 절차:
→ 진행할까요? (전체 / 일부선택 / 보류)
```
