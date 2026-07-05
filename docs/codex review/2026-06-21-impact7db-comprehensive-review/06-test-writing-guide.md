# Claude용 테스트 작성 가이드

## `write test @filename`의 의미

`write test @filename`은 Claude Code의 필수 전용 명령이 아니다.

- `@filename`: Claude의 현재 요청에 특정 파일을 컨텍스트로 첨부
- `write test`: 첨부한 구현에 대한 테스트를 작성하라는 자연어 지시

따라서 다음처럼 목적과 테스트 위치까지 명시하는 것이 더 정확하다.

```text
@functions-shared/src/llmHandler.js
외부 Firebase 인증 사용자가 거부되고 impact7 직원만 허용되는 회귀 테스트를
functions-shared/test/llmHandler.test.js에 작성해줘.
구현은 아직 수정하지 말고 테스트가 현재 코드에서 실패하는 것부터 확인해줘.
```

## 적용 원칙

이번 리뷰 수정은 가능한 범위에서 다음 순서를 따른다.

1. finding의 실패 시나리오를 재현하는 테스트 작성
2. 현재 코드에서 테스트가 실패하는지 확인
3. 최소 범위 구현 수정
4. 새 테스트와 기존 전체 테스트 실행
5. finding별 증거와 남은 위험 기록

테스트만으로 재현하기 어려운 CI, GitHub branch protection, 운영 배포 항목은 정적 검증과 workflow 검사로 대체한다.

## P0 테스트 매트릭스

### C-01. `exam_users` 자기 권한 상승

- 대상 구현: `firestore.rules`
- 권장 테스트 파일: `tests/firestore.rules.exam-users.test.js`
- 필수 케이스:
  - 일반 로그인 사용자의 자기 profile 표시 필드 변경 허용
  - 자기 `role`을 `owner`로 변경하는 요청 거부
  - 일반 사용자의 타인 문서 변경 거부
  - 승인된 owner/admin 경로의 역할 변경 허용
  - 비인증 read/write 거부

Claude 요청 예:

```text
@firestore.rules
C-01 회귀 테스트를 tests/firestore.rules.exam-users.test.js에 작성해줘.
자기 role 상승과 타인 문서 변경이 거부되는지 Firestore emulator로 검증해줘.
```

### C-02. 공개 HR 토큰

- 대상 구현: `firestore.rules`
- 권장 테스트 파일: `tests/firestore.rules.hr-tokens.test.js`
- 대상 컬렉션:
  - `onboardingTokens`
  - `contractSigningTokens`
  - `salaryAgreementTokens`
  - `shortTermTokens`
  - `employeeOnboardingTokens`
  - `employeeContractSigningTokens`
- 필수 케이스:
  - 비인증 collection list 거부
  - 비인증 direct get 거부
  - 권한 있는 director/staff의 필요한 관리 접근 허용
  - 만료 토큰 사용 거부
  - 완료된 토큰 재사용 거부
  - 토큰 대상과 다른 직원/계약 요청 거부
  - 토큰 1회 소비 보장

토큰 검증을 callable로 이동하면 rules 테스트와 함께 callable unit/integration 테스트를 추가한다.

### C-03. 직원 개인정보와 계약서 공개

- 대상 구현: `firestore.rules`
- 권장 테스트 파일: `tests/firestore.rules.hr-private-docs.test.js`
- 필수 케이스:
  - 비인증 staff/employee direct get 거부
  - 비인증 contract direct get 거부
  - 일반 staff의 타인 계약 조회 거부
  - 담당자 또는 director의 허용된 조회만 성공
  - 공개 토큰을 알아도 전체 직원 문서를 직접 읽을 수 없음

### H-01. Storage 권한

- 대상 구현: `storage.rules`
- 권장 테스트 파일: `tests/storage.rules.test.js`
- 필요한 도구: `@firebase/rules-unit-testing` Storage emulator 지원 방식 확인
- 필수 케이스:
  - 비인증 read/write/delete 거부
  - 일반 직원의 HR 계약·서명 접근 거부
  - 담당자 또는 director만 허용
  - 허용되지 않은 MIME 거부
  - 용량 초과 거부
  - 시험지/스캔과 HR 문서의 권한 정책 분리

### H-02. `llmGenerate` 인증과 비용 보호

- 대상 구현: `functions-shared/src/llmHandler.js`
- 권장 테스트 파일: 기존 `functions-shared/test/llmHandler.test.js` 확장
- 필수 케이스:
  - `request.auth` 없음 → `unauthenticated`
  - 외부 도메인 Firebase 사용자 → `permission-denied`
  - 이메일 미검증 사용자 → 거부
  - impact7 직원 → 허용
  - prompt 최대 길이 초과 → 거부
  - 허용되지 않은 model → 기본 model 또는 명시적 거부 정책 확인
  - 사용자별 rate limit/quota 초과 → `resource-exhausted`

## P1 데이터 정합성 테스트

### 학생 저장과 이력 원자성

- 대상 구현: `app.js`에서 분리할 저장 helper
- 권장:
  - Firestore write를 직접 UI 함수에서 테스트하기보다 저장 계획을 만드는 순수 helper를 분리한다.
  - emulator integration 테스트에서 student/history 중 하나가 실패할 때 전체가 rollback되는지 확인한다.
- 필수 케이스:
  - 학생 update + UPDATE history 동시 성공
  - status 변경 + STATUS_CHANGE history 동시 성공
  - history write 실패 시 student 변경도 반영되지 않음

### 일괄 퇴원 정합성

- 대상 구현:
  - `app.js`
  - `@impact7/shared/enrollment-status`
  - `firestore.rules`
- 권장 테스트 파일: `tests/bulk-withdrawal.test.js`
- 필수 케이스:
  - enrollment 보유 학생을 퇴원 처리할 때 enrollment 정리
  - status/enrollments/history가 같은 batch에 포함
  - 일부 학생 데이터가 유효하지 않아도 성공/실패 건수를 정확히 보고

### 내신 기간 동기화

- 대상 구현:
  - `functions/index.js`
  - `functions/src/syncNaesinPeriod.js`
- 기존 integration 테스트를 재사용한다.
- 필수 케이스:
  - 일시적 Firestore 오류가 trigger 성공으로 처리되지 않음
  - 재시도해도 history 중복 없음
  - 이미 반영된 enrollment를 다시 실행해도 결과 동일

### 성적 요약 동기화

- 대상 구현: `functions/src/syncStudentScores.js`
- 기존 `functions/test/syncStudentScores.integration.test.js` 확장
- 필수 케이스:
  - 존재하지 않는 summary 삭제는 멱등 성공
  - 네트워크/권한 오류는 삼키지 않고 재전파
  - result의 학생 식별값이 A에서 B로 변경되면 A의 stale summary 제거
  - trigger 재시도 시 동일 결과

### SMS fallback

- 대상 구현: `functions-shared/src/queueWorker.js`
- 기존 queue worker 테스트 확장
- 필수 케이스:
  - fallback SMS 문서 생성 성공 후에만 원본 `converted_to_sms`
  - SMS 문서 생성 실패 시 원본 retryable 유지
  - 중복 실행에도 SMS 문서 하나만 생성
  - callback은 최종 SMS 결과에서 1회만 실행

## 테스트 하네스 정리

Claude는 제품 수정 전에 다음 테스트 기반 문제도 정리해야 한다.

1. root rules 테스트용 `test:rules` script 추가
2. Functions emulator integration 테스트를 고유 project ID/namespace로 격리하거나 직렬 실행
3. `functions-shared/test/attendanceState.test.js`를 기본 test 명령에 포함
4. `school` 미러 기대값을 현재 `school_*` SSoT 계약에 맞게 수정
5. 날짜 의존 fixture에 clock injection 또는 fake timer 적용
6. Storage rules 테스트 추가

권장 명령 형태:

```json
{
  "scripts": {
    "test:unit": "...",
    "test:rules": "firebase emulators:exec --only firestore \"node --test tests/firestore.rules.*.test.js\"",
    "test:integration": "firebase emulators:exec --only firestore \"vitest run --no-file-parallelism\"",
    "test": "npm run test:unit && npm run test:rules"
  }
}
```

실제 script는 현재 package 구조와 Firebase CLI 동작을 확인한 뒤 최소 변경으로 구성한다.

## Claude의 보고 형식

각 테스트 작업 후 다음을 보고한다.

```text
Finding:
추가/수정한 테스트 파일:
실패 재현 명령:
수정 전 실패 내용:
구현 수정 파일:
수정 후 통과 결과:
전체 회귀 테스트 결과:
남은 미검증 영역:
```
