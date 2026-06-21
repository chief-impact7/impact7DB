# Executive Summary (검증·보정본)

## 결론

큰 구조는 타당하다.

- `impact7DB`가 Firestore/Storage rules의 SSoT 역할을 한다.
- Functions codebase가 `leave-request`와 `shared`로 분리돼 있다.
- `@impact7/shared`를 도메인 계약 기준으로 쓰는 방향도 적절하다.

그러나 운영 경계에 즉시 수정할 문제가 있고, 재검증에서 **보안 노출은 Codex 1차 평가보다 더 넓다**는 점이 확인됐다.

- 비인증 사용자가 HR 토큰, 직원 개인정보, 계약서를 읽을 수 있고, **공개 토큰 → staffId/contractId → 공개 get으로 전 직원 PII를 ID 추측 없이 일괄 수집**할 수 있다. [C-02·C-03·N-02]
- **외부 도메인 Firebase 계정**(impact7 밖 구글 계정)이 `exam_users`에서 자기 역할을 `owner`로 올리고, `exam_analyses`(내신분석자료)를 전부 읽을 수 있다. [C-01·N-01]
- 도메인 외 사용자가 유료 AI 게이트웨이(`llmGenerate`)를 호출할 수 있고, **모든 callable에 App Check가 꺼져 있다**. [H-02·N-05]
- 자동 배포가 테스트·lint를 거치지 않고, `firebase.json`에 predeploy 훅도 없다. [H-06·H-07·N-04]
- 학생 저장·이력·요약 동기화에 부분 성공과 silent failure 경로가 있다. [H-04·H-05·M-01·H-08]

판정: **REQUEST CHANGES**.

## Codex 대비 평가 보정 (중요)

- **상향:** O-04(필드 36 제한 vs 허용 48 → 조용한 저장 거부)는 ops가 아니라 데이터 신뢰성 리스크 → Medium.
- **하향:** H-03(상태 분리)는 `allStudents`가 store와 같은 배열 참조라 stale 위험 거의 없음 → Low/Medium. H-05는 수동 복구 경로 존재 → Medium. H-08·O-05도 일부 과장.
- **추가:** 외부 계정 노출(N-01), PII 익스플로잇 체인(N-02), App Check 부재(N-05) 등 10건.
- **정정:** M-04 예시 `naesin-schedule.js:345`는 버그 아님(안전 패턴).

## 최우선 조치

### P0 — 운영 노출 차단 (보안)

1. `exam_users` 자기 수정 필드 allowlist + `role` 변경은 서버/콘솔 전용. read도 도메인 검사로. [C-01·N-01]
2. `exam_analyses` read/create를 `isAuthorized()`(도메인)로 전환. [N-01]
3. 공개 토큰 `read: if true` 6곳 제거 + 토큰 검증을 callable로 이동, 1회 소비 transaction. [C-02·N-02]
4. 직원/계약 공개 `get: if true` 4곳 제거, 마스킹 최소정보는 callable로. [C-03·N-02]
5. Storage 경로별 역할·소유권·MIME·크기 검사. [H-01]
6. `llmGenerate`에 `assertAuthorizedStaff()` + per-uid rate limit, 전 callable App Check 단계 도입. [H-02·N-05]

> **크로스앱 주의:** 3·4·5는 **HR 앱(별도 repo)의 공개 온보딩/서명/업로드 플로우가 깨진다**. rules만 닫지 말고, HR 앱을 callable 경유로 먼저 이전한 뒤 닫는다. (impact7-orchestrator로 조율)

### P0 — 검증 없는 배포 차단 (CI)

1. Functions workflow에 validate job(lint/test/emulator) 선행, `deploy`에 `needs: validate`. [H-06]
2. `firebase.json` predeploy 훅 추가. [N-04]
3. Hosting dispatch `curl --fail-with-body` + downstream run 추적. [H-07]
4. functions/functions-shared lockfile 추적(`.gitignore` 규칙 경로 한정) + `npm ci`. [M-07]
5. `master` branch protection + required checks.

### P1 — 데이터 정합성

1. 학생 저장 + 필수 history를 같은 writeBatch/transaction으로. [H-04]
2. 일괄 퇴원에 `reconcileEnrollments()` 적용 + status 메타 기록 + 부분성공 보고. [M-04·M-05·N-07·N-08]
3. 내신/성적 trigger 멱등화 후 오류 재전파, retry/마커. [H-05·M-01·N-06]
4. SMS fallback 전환을 원자화, 실패 시 원본 retryable 유지. [H-08]
5. `currentStudentId` store 미러 누락 정리. [H-03]

### P2 — 운용·유지보수

1. `migrate:label` 깨진 스크립트 제거. [O-01]
2. `migrate-school-by-level.js` school 미러 write 제거. [O-02]
3. `help-guide.js` 정본 단일화(양방향 fork 병합). [O-03]
4. 백필 dry 기본화. [M-02], 광역 deploy 스크립트 고정. [M-03]
5. shared 버전 3패키지 통일 + `update-shared.yml`이 전 패키지 bump. [M-06·N-03]
6. 테스트 하네스 정리(격리·계약 fixture·Storage rules 테스트·`test:rules`·emulators 블록). [M-08·N-10]
7. 학생 필드 36 한도 재검토. [O-04]

## 독립 리뷰 판정

- 코드리뷰: `REQUEST CHANGES`
- 아키텍처: `WATCH`
- 테스트 신뢰성: `CRITICAL`

아키텍처 자체를 폐기할 문제는 아니다. 그러나 보안 경계가 코드 수준에서 강제되지 않고(특히 외부 계정·App Check), 배포 게이트가 없어 drift·사고 가능성이 높다.
