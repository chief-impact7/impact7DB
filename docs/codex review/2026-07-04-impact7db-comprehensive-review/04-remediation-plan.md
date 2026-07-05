# Remediation Plan

## Phase 1: 보안/운영 게이트

1. dependency audit 정리
   - root/functions/functions-shared 순서로 `npm audit fix` 가능한 범위를 적용한다.
   - `firebase-admin` major/breaking 변경은 별도 PR로 분리한다.
   - 검증: root build/test/storage, functions emulator integration, functions-shared test.

2. Cloud Run invoker 복구 allowlist화
   - `.github/workflows/deploy-functions.yml`의 전체 서비스 순회를 중단한다.
   - 공개가 필요한 callable/HTTP 서비스명 allowlist를 만든다.
   - 미래 내부 서비스가 public으로 열리지 않는 정적 검증을 추가한다.

3. App Check rollout
   - 직원 전용 callable을 그룹화한다.
   - 저위험 callable부터 `enforceAppCheck: true` 카나리 적용.
   - 공개 토큰 callable은 예외 목록과 별도 abuse 방어 테스트를 둔다.

## Phase 2: 테스트 실행 계약 정리

1. `functions/package.json` test script 정리
   - `test:unit`: emulator 불필요 테스트만.
   - `test:integration`: emulator wrapper 포함.
   - `test`: CI와 동일한 검증 또는 명확한 조합.

2. CI와 로컬 명령 통일
   - `.github/workflows/deploy-functions.yml`과 package scripts가 같은 명령을 쓰게 한다.
   - 문서/README에 emulator 전제 테스트를 명시한다.

## Phase 3: 프론트 정합성·신속성

1. `app.js` 상태 mutation 축소
   - 수정하는 기능부터 `allStudents` 직접 push/대입 대신 새 배열 교체 + `storeUpdate`를 사용한다.
   - `currentFilteredStudents`를 store 기준으로 통일한다.

2. pure helper 추출과 테스트 추가
   - bulk status/class/day/school payload 생성 로직을 helper로 분리한다.
   - Firestore rules가 요구하는 enrollment/status 계약과 같은 입력으로 테스트한다.

3. chunk 분리
   - Google Sheets, daily stats, bulk actions, leave request UI처럼 독립 블록부터 dynamic import 후보로 분리한다.
   - build chunk warning을 기준으로 성과를 측정한다.

## Phase 4: 운영 스크립트 안전화

1. 쓰기 스크립트 표준 가드
   - 모든 운영 쓰기 스크립트에 dry-run 기본값, `--execute` 또는 `--apply`, projectId 출력, 대상 건수 요약을 강제한다.

2. root 일회성 스크립트 정리
   - 오래된 `_check_*.cjs`, `_fix_*.cjs` 류는 `_archive` 또는 docs로 이동한다.
   - active script와 historical artifact를 분리해 실수 실행 가능성을 줄인다.

## 완료 기준

- 세 패키지 `npm audit --omit=dev`가 0건이거나, 남은 항목이 Firebase upstream 제한으로 문서화되어 있다.
- functions 기본 test command가 단독 실행해도 misleading failure를 내지 않는다.
- deploy workflow가 public invoker 대상 서비스를 명시적으로 제한한다.
- 신규 프론트 변경이 `app.js` 추가가 아니라 모듈/테스트 단위로 들어간다.
