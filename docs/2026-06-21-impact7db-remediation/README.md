# impact7DB 종합 리뷰 — 검증·보완 완성본 (작업폴더)

- 작성일: 2026-06-21
- 대상: `/Users/jongsooyi/IMPACT7/impact7DB`
- 입력: `docs/codex review/2026-06-21-impact7db-comprehensive-review/` (Codex 1차 리뷰)
- 이 폴더: Codex 발견사항을 **실제 코드와 전수 재검증**하고, 오류 수정·과대/과소평가 보정·누락 발견사항 추가로 만든 **실행용 작업폴더**
- 최종 판정: **REQUEST CHANGES** (Codex 판정 유지 — 근거는 더 강해짐)

## Codex 리뷰 대비 무엇이 달라졌나

Codex 1차 리뷰는 파일·라인 단위로 **대체로 정확**했다. 보안 핵심(C-01~C-03, H-01)은 라인 번호까지 일치한다. 다만 재검증에서 다음을 바로잡았다.

| 구분 | 내용 |
|------|------|
| **과대평가 정정** | H-03(상태 분리)은 `allStudents`가 store와 **같은 배열 참조(alias)**라 stale 위험이 거의 없음 → High→Low/Med. H-08(SMS)·O-05(번들)도 일부 과장 |
| **잘못된 인용 정정** | M-04 예시 중 `naesin-schedule.js:345`는 **버그 패턴이 아니라 올바른 패턴**(루프 내부 동기화) |
| **과소평가 상향** | O-04(필드 36 제한 vs 허용 48)는 조용한 저장 거부 위험 → Med로 상향. H-05는 Med로 하향 |
| **누락 발견 추가(N-01~N-10)** | 외부 Firebase 계정의 `exam_analyses`/`exam_users` 접근, 공개 토큰→PII get 익스플로잇 체인, App Check 전면 부재, update-shared.yml 루트만 갱신, syncNaesinPeriod 비원자성 등 |
| **크로스앱 리스크 명시** | 공개 토큰 read 제거·Storage HR 경로 강화는 **HR 앱(별도 repo) 코드 변경과 동시**여야 함 — rules만 닫으면 HR 온보딩/서명 플로우가 깨짐 |

## 문서 구성

1. [00-verification-log.md](./00-verification-log.md) — **Codex 발견별 재검증 결과**(판정·정정 라인·delta). 이 폴더의 핵심
2. [01-executive-summary.md](./01-executive-summary.md) — 보정된 우선순위와 판정
3. [02-findings.md](./02-findings.md) — 정정·재평가된 전체 발견사항 + 신규 발견(N-01~N-10)
4. [03-validation-evidence.md](./03-validation-evidence.md) — 재현·재실행한 검증 증거(실제 테스트 출력 포함)
5. [04-remediation-plan.md](./04-remediation-plan.md) — 보정된 단계별 수정 계획 + 크로스앱 순서
6. [05-claude-handoff-prompt.md](./05-claude-handoff-prompt.md) — 실행 에이전트 전달용 지시문
7. [06-test-writing-guide.md](./06-test-writing-guide.md) — 회귀 테스트 매트릭스(신규 발견 포함)

## 검증 방법

- `firestore.rules`(1294줄)·`storage.rules`(50줄): 직접 전문 정독
- `app.js`·`store.js`·`past-history.js`·`naesin-schedule.js`·`promo-extractor.js`: 상태/원자성 전수 추적
- `functions/`·`functions-shared/`: 트리거 설정·에러 처리·인증 가드 전수 확인
- CI/패키징: 워크플로·package.json·lockfile 추적 상태 확인
- 테스트: 순수 단위 테스트는 **실제 실행**해 pass/fail 확인, `npm audit` 재실행으로 수치 대조

## 주의 — 이 작업폴더는 "리뷰"이지 "수정"이 아니다

리뷰 과정에서 **소스 코드는 수정하지 않았다**. 실제 수정은 04-remediation-plan.md 순서로 진행하고, 소스 변경 커밋 전 프로젝트 규칙대로 `simplify` → `code-review` → quality guard marker를 적용한다. 운영 배포는 사용자 승인 후에만.
