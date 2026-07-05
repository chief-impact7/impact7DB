# 상세 발견사항

## CRITICAL

### C-01. `exam_users` 자기 권한 상승

- 위치: `firestore.rules:198-203`
- 현상: 로그인 사용자는 자기 문서 전체를 쓸 수 있다.
- 실패 시나리오:
  1. 사용자가 자기 `exam_users/{uid}` 문서에 `role: "owner"`를 저장한다.
  2. 이후 owner 조건을 만족해 다른 사용자 문서도 수정한다.
- 권장:
  - 자기 수정은 표시명 등 명시적인 필드만 허용한다.
  - `role`은 Admin SDK, custom claim 또는 관리자 전용 서버 경로에서만 변경한다.

### C-02. 비인증 HR 토큰 목록 조회

- 위치:
  - `firestore.rules:779-791`
  - `firestore.rules:797-808`
  - `firestore.rules:814-825`
  - `firestore.rules:860-871`
  - `firestore.rules:993-1015`
- 현상: `allow read: if true`는 단건 `get`뿐 아니라 컬렉션 `list`도 허용한다.
- 영향: 온보딩, 계약 서명, 급여 약정, 단기직 토큰을 수집하고 재사용할 수 있다.
- 권장:
  - 클라이언트의 토큰 컬렉션 read를 차단한다.
  - callable/HTTP backend가 토큰 하나만 검증하고 최소 결과만 반환한다.
  - 토큰을 대상 이메일·직원·계약에 바인딩하고 트랜잭션으로 1회 소비한다.

### C-03. 직원 개인정보와 계약서의 비인증 조회

- 위치:
  - `firestore.rules:876-889`
  - `firestore.rules:891-915`
  - `firestore.rules:1021-1045`
- 현상: `staff`, `employees`, 계약 문서에 무조건적인 `allow get: if true`가 있다.
- 영향: 문서 ID를 알면 주민번호, 주소, 계좌, 세무 정보, 급여, 서명 데이터가 노출될 수 있다.
- 권장:
  - 공개 `get`을 제거한다.
  - 토큰 검증 서버가 마스킹된 최소 정보만 반환한다.

## HIGH

### H-01. Storage 권한이 HR 역할과 소유권을 우회

- 위치: `storage.rules:12-37`
- 현상: impact7 도메인 계정이면 시험지, 스캔, 직원 문서, 계약서, 경비, 서명을 모두 읽고 쓸 수 있다.
- 영향: Firestore의 director/assignedTo 권한보다 Storage가 훨씬 넓다.
- 권장:
  - 경로별 read/create/update/delete를 분리한다.
  - Firestore의 HR 역할과 리소스 소유권을 검사한다.
  - 파일 크기와 MIME allowlist를 모든 경로에 적용한다.

### H-02. `llmGenerate` 비용 악용

- 위치: `functions-shared/src/llmHandler.js:36-39`
- 현상: Firebase 인증 여부만 검사하고 impact7 직원 여부를 검사하지 않는다.
- 영향: 외부 계정이 Vertex AI 비용을 반복 발생시킬 수 있다.
- 권장:
  - 공통 `assertAuthorizedStaff()`를 적용한다.
  - 사용자별 quota/rate limit와 App Check를 추가한다.

### H-03. `app.js`와 `store.js` 상태 분리

- 위치:
  - `app.js:146-171`
  - `app.js:851-876`
  - `app.js:2144-2148`
  - `app.js:5292`
  - `store.js:28-83`
  - `past-history.js:280-309`
- 현상:
  - `app.js`가 store와 별도로 같은 상태를 보유한다.
  - 학생 저장 후 로컬 `allStudents`만 직접 변경한다.
  - 일부 선택 해제 경로에서 `currentStudentId=null`을 store에 반영하지 않는다.
- 영향: 홍보 추출기, 내신 시간표, 과거 이력 등이 stale state를 읽을 수 있다.
- 권장:
  - `state.allStudents`와 `state.currentStudentId`를 실제 SSoT로 만든다.
  - immutable 배열을 `storeUpdate()`로 교체한다.

### H-04. 학생 저장과 history log의 부분 성공

- 위치:
  - `app.js:2577-2629`
  - `app.js:2682-2704`
  - `app.js:2730-2740`
- 현상: 학생 문서와 이력 문서를 별도 쓰기로 처리한다.
- 영향:
  - 학생 저장 후 이력 저장이 실패할 수 있다.
  - UI가 저장 실패를 표시해도 학생 문서는 이미 변경됐을 수 있다.
- 권장: 학생 변경과 필수 audit log를 같은 `writeBatch` 또는 transaction에 넣는다.

### H-05. 내신 기간 동기화 오류를 정상 종료

- 위치: `functions/index.js:144-162`
- 현상: `retry:false`이며 `syncNaesinPeriod()` 오류를 로그만 남기고 삼킨다.
- 영향: `class_settings`와 학생 enrollment 기간이 영구적으로 달라질 수 있다.
- 권장: 멱등성을 보장한 후 오류를 재전파하고 retry/checkpoint를 적용한다.

### H-06. 검증 없는 Functions 자동 배포

- 위치: `.github/workflows/deploy-functions.yml:21-59`
- 현상: checkout과 `npm install` 후 바로 운영 Functions를 배포한다.
- 영향: 현재처럼 테스트 suite가 실패해도 master push만으로 배포된다.
- 권장:
  - validate job에서 lint/unit/emulator integration/import smoke를 실행한다.
  - deploy job은 `needs: validate`를 사용한다.

### H-07. Hosting workflow의 false positive

- 위치: `.github/workflows/deploy.yml:14-19`
- 현상:
  - `curl -s`가 HTTP 오류를 workflow 실패로 처리하지 않는다.
  - downstream 통합 배포 종료를 기다리지 않는다.
- 실제 증거: impact7DB workflow는 성공했지만 같은 시점의 통합 hosting run이 취소된 이력이 있다.
- 권장: `curl --fail-with-body`를 사용하고 downstream run ID를 추적해 최종 결론을 반영한다.

### H-08. SMS fallback 생성 실패 시 메시지 유실

- 위치: `functions-shared/src/queueWorker.js:256-298`
- 현상: SMS 문서 생성 실패를 catch한 후 원본을 `converted_to_sms`로 종결한다.
- 영향: 원본과 fallback 모두 처리되지 않고 사용자에게 결과 callback도 가지 않는다.
- 권장: fallback 문서 생성과 원본 상태 변경을 transaction/batch로 묶고, 실패 시 원본을 retryable 상태로 유지한다.

## MEDIUM

### M-01. 성적 요약 삭제 오류 무시

- 위치: `functions/src/syncStudentScores.js:49-71`
- 현상: 삭제 update 오류를 전부 `.catch(() => {})`로 삼키고 trigger도 `retry:false`다.
- 영향: 삭제된 성적이 `student_scores`에 계속 남을 수 있다.
- 권장: `NOT_FOUND`만 멱등 성공으로 처리하고 나머지 오류는 재전파한다.

### M-02. 성적 백필이 기본 실행 모드

- 위치: `functions/backfill-student-scores.mjs:8-11`
- 현상: `--dry`를 지정하지 않으면 production project에 즉시 쓴다.
- 권장: 기본 dry-run, 실행은 `--run --project impact7db`처럼 이중 명시를 요구한다.

### M-03. 광역 Functions deploy script

- 위치: `functions/package.json:11`
- 현상: `firebase deploy --only functions`가 두 codebase를 함께 배포할 수 있다.
- 권장: `functions:leave-request --project impact7db`로 고정한다.

### M-04. 일괄 작업 부분 성공 처리 부족

- 위치:
  - `app.js:3472`
  - `app.js:4216`
  - `app.js:5004`
  - `app.js:5265`
  - `app.js:6398`
  - `naesin-schedule.js:345`
- 현상: 여러 batch 중 뒤 청크가 실패하면 앞 청크는 이미 반영됐지만 전체 실패로 표시한다.
- 권장: 청크별 성공 ID를 기록하고 성공 건만 로컬 상태에 반영하며, 재시도 가능한 operation ID를 남긴다.

### M-05. 상태 변경과 enrollment 정합성 충돌

- 위치:
  - `app.js:4797-4843`
  - `app.js:5249-5296`
  - `firestore.rules:103-120`
- 현상: 일괄 퇴원은 `status`만 변경하고 enrollment를 유지한다.
- 영향: enrollment 보유 학생은 rules에 의해 전체 batch가 거부될 수 있다.
- 권장: 공유 `reconcileEnrollments()` 계약에 따라 enrollment 정리, 상태, audit log를 한 batch로 처리한다.

### M-06. `@impact7/shared` 버전 drift

- 위치:
  - `package.json:28` — v1.30.0
  - `functions-shared/package.json:14` — v1.30.0
  - `functions/package.json:15` — v1.28.0
  - `scripts/check-shared-lock-sync.mjs:7-12`
- 현상: leave-request Functions만 이전 계약을 사용하고 guard는 루트만 검사한다.
- 권장: 세 package 버전을 일치시키고 subpackage까지 guard한다.

### M-07. 재현 불가능한 Functions 의존성

- 위치:
  - `.gitignore:17`
  - `.github/workflows/deploy-functions.yml:43-57`
- 현상: Functions lockfile이 추적되지 않고 CI가 `npm install`을 사용한다.
- 영향: 동일 SHA도 배포 시점마다 다른 transitive dependency를 사용할 수 있다.
- 권장: child lockfile을 추적하고 `npm ci`를 사용한다.

### M-08. 테스트 격리와 계약 drift

- Functions 통합 테스트는 동일 emulator project/컬렉션을 병렬 삭제해 서로 간섭한다.
- functions-shared 테스트는 현재 계약과 다른 `school` 미러 및 `복귀` 라벨을 기대한다.
- 출결 테스트는 기본 Vitest suite에서 제외돼 실패가 숨겨져 있다.
- Storage rules 테스트는 없다.

## 유지보수·운용 문제

### O-01. 깨진 npm script

- `package.json:18-19`가 존재하지 않는 `migrate-school-label.js`를 실행한다.
- 실제 실행 결과: `MODULE_NOT_FOUND`

### O-02. 폐기된 `school` 미러 재생성

- `migrate-school-by-level.js:24-25`가 현재 계약에서 제거된 `school` 필드를 다시 쓴다.
- Admin SDK는 rules를 우회하므로 실제 drift를 재도입할 수 있다.

### O-03. 중복 help guide

- `help-guide.js`와 `public/help-guide.js`의 내용과 해시가 다르다.
- `index.html`은 `help-guide.js`를 로드하지만 Vite에서는 public 파일이 최종 경로를 차지해 수정 대상이 혼동된다.

### O-04. 학생 문서 필드 제한

- rules의 허용 필드 목록은 48개다.
- create/update 제한은 `withinFieldLimit(36)`이다.
- 선택 필드가 누적된 정상 문서가 저장 거부될 가능성이 있다.

### O-05. 성능 경고

- production build 메인 chunk: 약 625KB
- `help-guide.js`는 module이 아니어서 bundling 경고가 발생한다.
- 기능 장애는 아니지만 초기 로드와 캐시 효율 개선 대상이다.
