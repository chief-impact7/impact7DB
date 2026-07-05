# Executive Summary

## 결론

큰 구조는 타당하다.

- `impact7DB`가 Firestore/Storage rules의 SSoT 역할을 한다.
- Functions codebase가 `leave-request`와 `shared`로 분리돼 있다.
- `@impact7/shared`를 도메인 계약의 기준으로 사용하려는 방향도 적절하다.

그러나 현재 운영 경계에는 즉시 수정해야 할 문제가 있다.

- 비인증 사용자가 HR 토큰, 직원 개인정보, 계약서를 읽을 수 있다.
- 일반 로그인 사용자가 `exam_users`에서 자기 역할을 `owner`로 올릴 수 있다.
- 도메인 외 Firebase 사용자도 유료 AI 게이트웨이를 호출할 수 있다.
- 자동 배포가 테스트와 lint를 거치지 않는다.
- 학생 데이터, 이력, 비정규화 요약 간 부분 성공과 silent failure가 가능하다.
- `app.js` 로컬 상태와 `store.js` 상태가 쉽게 분리된다.

따라서 현재 판정은 **REQUEST CHANGES**다.

## 최우선 조치

### P0 — 운영 노출 차단

1. Firestore 공개 HR 토큰 및 직원/계약 `get` 제거
2. `exam_users` 자기 수정 필드 제한
3. Storage 경로별 역할·소유권 검사 추가
4. `llmGenerate`에 직원 도메인 검사, quota/rate limit 적용

### P0 — 검증 없는 배포 차단

1. Functions workflow에 lint/test/emulator validation 선행
2. Hosting dispatch HTTP 실패 감지 및 downstream 결과 확인
3. `master` 필수 check와 branch protection 적용
4. Functions lockfile 추적 및 `npm ci` 사용

### P1 — 데이터 정합성

1. 학생 저장과 history log를 batch/transaction으로 묶기
2. 내신/성적 동기화에서 오류를 삼키지 말고 멱등 재시도
3. 일괄 작업의 부분 성공을 기록하고 성공 청크만 로컬 상태에 반영
4. `store.js`를 실제 단일 상태 원천으로 전환

## 독립 리뷰 판정

- 코드리뷰: `REQUEST CHANGES`
- 아키텍처 리뷰: `WATCH`
- 테스트 신뢰성: `CRITICAL`

아키텍처 전체를 폐기할 문제는 아니지만, 보안과 운영 경계가 코드 수준에서 강제되지 않아 drift와 사고 가능성이 높다.
