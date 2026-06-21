# 테스트 작성 가이드 (검증·보완본)

## 적용 원칙

1. finding의 실패 시나리오를 재현하는 테스트 작성
2. 현재 코드에서 그 테스트가 **실패**하는지 확인(취약 동작 증명)
3. 최소 범위 구현 수정
4. 새 테스트 + 기존 전체 회귀 실행
5. finding별 증거·잔존 위험 기록

테스트로 재현 어려운 CI/branch protection/배포 항목은 정적 검증·workflow 검사로 대체한다.

## 사전 정비 (먼저 해야 테스트가 돌아감)

- `firebase.json`에 `emulators` 블록 추가(firestore/storage 포트). [N-10]
- root `package.json`에 `test:rules` 스크립트 추가(아래 예시).
- 통합 테스트 격리: 파일별 고유 projectId 또는 `--no-file-parallelism`(직렬). [M-08]
- 계약 fixture 갱신: `student-label-sync.test.js`(school 미러 제거 → `school_*`), `attendanceState.test.js`(`복귀`→`귀원`), `chatSyncHandler.test.js`(clock injection). [M-08]
- `attendanceState.test.js`를 실제 실행 경로에 편입(`node --test` 스크립트). [M-08]

```json
{
  "scripts": {
    "test:unit": "node --test tests/*.unit.test.js",
    "test:rules": "firebase emulators:exec --only firestore,storage \"node --test tests/firestore.rules.*.test.js tests/storage.rules.*.test.js\"",
    "test": "npm run test:unit && npm run test:rules"
  }
}
```
(실제 스크립트는 현 package 구조·Firebase CLI 동작 확인 후 최소 변경으로.)

## P0 보안 테스트 매트릭스

### C-01 + N-01. exam_users 권한 상승 / 외부 도메인
- 대상: `firestore.rules` · 파일: `tests/firestore.rules.exam-users.test.js`
- 케이스:
  - 일반 사용자 자기 표시 필드 변경 허용
  - 자기 `role`을 `owner`로 변경 거부
  - 타인 문서 변경 거부
  - 승인된 owner/admin 경로 역할 변경 허용
  - 비인증 read/write 거부
  - **(N-01) 외부 도메인(@gmail 등) 인증 계정의 read/write 거부**

### N-01. exam_analyses 외부 read
- 대상: `firestore.rules` · 파일: `tests/firestore.rules.exam-analyses.test.js`
- 케이스:
  - 외부 도메인 인증 계정의 read 거부
  - impact7 도메인 계정 read 허용
  - createdBy 본인만 update/delete

### C-02 + N-02. 공개 HR 토큰 / PII 체인
- 대상: `firestore.rules` · 파일: `tests/firestore.rules.hr-tokens.test.js`
- 대상 컬렉션: onboardingTokens, contractSigningTokens, salaryAgreementTokens, shortTermTokens, employeeOnboardingTokens, employeeContractSigningTokens
- 케이스:
  - 비인증 collection list 거부
  - 비인증 direct get 거부
  - 권한 있는 director/staff의 관리 접근 허용
  - 만료 토큰 사용 거부 / 완료 토큰 재사용 거부
  - 토큰 대상과 다른 직원/계약 요청 거부
  - 토큰 1회 소비 보장
  - **(N-02) 토큰 list로 staffId/contractId 수집 → 그 ID로 staff/employee get 시도 → 거부**
- 토큰 검증을 callable로 옮기면 callable unit/integration 테스트도 추가.

### C-03. 직원/계약 공개 get
- 대상: `firestore.rules` · 파일: `tests/firestore.rules.hr-private-docs.test.js`
- 케이스:
  - 비인증 staff/employee direct get 거부
  - 비인증 contract direct get 거부
  - 일반 staff의 타인 계약 조회 거부
  - 담당자/director의 허용 조회만 성공
  - 공개 토큰을 알아도 전체 직원 문서 직접 read 불가

### H-01. Storage 권한
- 대상: `storage.rules` · 파일: `tests/storage.rules.test.js`
- 도구: `@firebase/rules-unit-testing` Storage emulator
- 케이스:
  - 비인증 read/write/delete 거부
  - 일반 직원의 HR 계약·서명 접근 거부
  - 담당자/director만 허용
  - 허용 외 MIME 거부 / 용량 초과 거부
  - 시험지·스캔과 HR 문서 권한 정책 분리

### H-02 + N-05. llmGenerate 인증·비용
- 대상: `functions-shared/src/llmHandler.js` · 파일: `functions-shared/test/llmHandler.test.js` 확장
- 케이스:
  - `request.auth` 없음 → `unauthenticated`
  - 외부 도메인 사용자 → `permission-denied`
  - 이메일 미검증 → 거부
  - impact7 직원 → 허용
  - prompt 최대 길이 초과 → 거부
  - 허용 외 model → 기본 model 또는 명시 거부
  - per-uid rate limit/quota 초과 → `resource-exhausted`
  - (N-05) App Check 미통과 → 거부(도입 후)

## P1 데이터 정합성 테스트

### 학생 저장·이력 원자성 [H-04]
- 저장 계획을 만드는 순수 helper를 `app.js`에서 분리해 단위 테스트.
- emulator 통합: student/history 중 하나 실패 시 전체 rollback.
- 케이스: 학생 update + UPDATE history 동시 성공 / status 변경 + STATUS_CHANGE 동시 / history 실패 시 student 미반영.

### 일괄 퇴원 정합성 [M-05·N-07]
- 대상: `app.js` + `@impact7/shared/enrollment-status` + `firestore.rules` · 파일: `tests/bulk-withdrawal.test.js`
- 케이스:
  - enrollment 보유 학생 퇴원 시 enrollment 정리(rule 통과)
  - status/enrollments/history 같은 batch
  - **(N-07) status_changed_at/status_previous 기록 확인**
  - 일부 학생 데이터 무효여도 성공/실패 건수 정확 보고

### 내신 기간 동기화 [H-05·N-06]
- 대상: `functions/index.js` + `functions/src/syncNaesinPeriod.js` · 기존 integration 재사용
- 케이스:
  - 일시 Firestore 오류가 trigger 성공으로 처리되지 않음(재전파)
  - 재시도해도 history 중복 없음
  - 이미 반영된 enrollment 재실행 결과 동일(멱등)
  - (N-06) 부분 청크 실패 시 마커 기록/재시도

### 성적 요약 동기화 [M-01]
- 대상: `functions/src/syncStudentScores.js` · 기존 integration 확장
- 케이스:
  - 없는 summary 삭제는 NOT_FOUND 멱등 성공
  - 네트워크/권한 오류는 재전파(삼키지 않음)
  - 학생 식별값 A→B 변경 시 A의 stale summary 제거
  - trigger 재시도 결과 동일

### SMS fallback [H-08]
- 대상: `functions-shared/src/queueWorker.js` · 기존 queue worker 테스트 확장
- 케이스:
  - fallback SMS 문서 생성 성공 후에만 원본 `converted_to_sms`
  - SMS 문서 생성 실패 시 원본 retryable 유지
  - 중복 실행에도 SMS 문서 1개
  - callback은 최종 SMS 결과에서 1회만

### 문법특강 phantom 상태 [N-08]
- 대상: `app.js` 문법특강 저장 경로
- 케이스: `batch.commit()` 실패 시 로컬 `allStudents`에 미커밋 학생/enrollment가 남지 않음

## 테스트 하네스 정리 체크리스트

1. root `test:rules` 스크립트 추가
2. 통합 테스트 고유 projectId/namespace 또는 직렬화
3. `attendanceState.test.js`를 실제 실행 경로에 편입
4. `school` 미러 기대값 → `school_*` SSoT로 수정
5. 날짜 의존 fixture clock injection/fake timer
6. Storage rules 테스트 추가
7. `firebase.json` emulators 블록 추가

## 보고 형식 (테스트 작업별)

```text
Finding:
추가/수정 테스트 파일:
실패 재현 명령:
수정 전 실패 내용:
구현 수정 파일:
수정 후 통과 결과:
전체 회귀 결과:
크로스앱 영향:
남은 미검증 영역:
```
