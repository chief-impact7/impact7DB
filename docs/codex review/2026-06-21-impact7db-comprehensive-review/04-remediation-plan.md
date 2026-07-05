# 권장 수정 계획

## Phase 1. 보안 차단

### 목표

비인증 또는 권한 없는 사용자가 토큰, HR 개인정보, 계약서, Storage 파일, AI 비용에 접근하지 못한다.

### 작업

1. `exam_users` 자기 수정 allowlist 도입
2. 공개 토큰 `read`와 직원/계약 `get` 제거
3. 토큰 검증 callable과 1회성 transaction 구현
4. Storage 역할·소유권·MIME·크기 제한 구현
5. `llmGenerate` 직원 인증과 rate limit 적용
6. 해당 Firestore/Storage rules emulator 테스트 추가

### 완료 기준

- 비인증 list/get가 모두 거부된다.
- 유효한 대상 토큰만 1회 사용할 수 있다.
- 일반 직원은 다른 직원 계약/서명을 읽거나 변경할 수 없다.
- 외부 Firebase 사용자의 AI 호출이 거부된다.

## Phase 2. 배포 게이트

### 작업

1. Functions child lockfile 추적
2. CI에서 `npm ci` 사용
3. codebase별 validate job 추가
4. emulator integration test 격리 또는 직렬화
5. `deploy` job에 `needs: validate`
6. broad deploy script 제거
7. Hosting dispatch HTTP/downstream 검증
8. branch protection과 required checks 적용

### 완료 기준

- 테스트가 실패하면 production deploy가 실행되지 않는다.
- 같은 SHA는 동일 dependency tree로 배포된다.
- 초록색 Hosting workflow가 실제 downstream 성공을 의미한다.

## Phase 3. 데이터 정합성

### 작업

1. 학생 저장과 필수 이력을 atomic write로 변경
2. 일괄 상태/퇴원에서 `reconcileEnrollments()` 적용
3. 내신·성적 trigger를 멱등화하고 retry 활성화
4. SMS fallback 전환을 atomic하게 변경
5. 다중 batch 작업의 부분 성공 기록과 재시도 모델 도입

### 완료 기준

- student와 history log가 한쪽만 저장되지 않는다.
- status와 enrollments가 모든 저장 경로에서 같은 계약을 따른다.
- trigger 실패가 성공으로 은폐되지 않는다.
- 일괄 작업 실패 시 정확한 성공/실패 건수가 표시된다.

## Phase 4. 상태와 shared 계약 정리

### 작업

1. `state.allStudents`와 `state.currentStudentId`를 실제 SSoT로 전환
2. 직접 mutation 제거
3. root/functions/functions-shared shared 버전 통일
4. subpackage lock/version guard 확장
5. `app.js` 수정 대상 블록을 기존 모듈 분리 규칙에 따라 점진 분리

### 완료 기준

- 저장 직후 모든 모듈이 같은 학생 데이터를 본다.
- store 변경 알림이 누락되지 않는다.
- 세 package가 동일 shared 계약을 사용한다.

## Phase 5. 운용 정리

1. 깨진 `migrate:label` script 제거 또는 복원
2. `migrate-school-by-level.js`의 `school` mirror write 제거
3. `help-guide.js` 정본 하나만 유지
4. 백필 기본값을 dry-run으로 변경
5. 학생 필드 36개 제한의 실제 의도 재검토
6. dependency audit의 runtime 도달 가능성 분석 및 업데이트
7. rollback workflow와 post-deploy smoke test 추가

## 권장 커밋 분리

1. `security: close public HR and exam privilege paths`
2. `ci: gate production deploys on deterministic validation`
3. `reliability: make student and trigger writes atomic`
4. `architecture: make store and shared contracts authoritative`
5. `maintenance: remove stale scripts and duplicated assets`

각 소스 코드 커밋 전 프로젝트 규칙에 따라 `simplify` 후 `code-review`를 수행하고 staged quality marker를 기록한다.
