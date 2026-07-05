# Claude Code 전달용 지시문

아래 문장을 Claude Code에 전달한다.

```text
이 저장소의 Codex 종합 리뷰 문서를 읽고 수정 작업을 진행해줘.

리뷰 문서:
@docs/codex review/2026-06-21-impact7db-comprehensive-review/README.md
@docs/codex review/2026-06-21-impact7db-comprehensive-review/02-findings.md
@docs/codex review/2026-06-21-impact7db-comprehensive-review/03-validation-evidence.md
@docs/codex review/2026-06-21-impact7db-comprehensive-review/04-remediation-plan.md
@docs/codex review/2026-06-21-impact7db-comprehensive-review/06-test-writing-guide.md

요구사항:
1. 먼저 AGENTS.md와 .memory/MEMORY.md를 읽어라.
2. codegraph_explore를 먼저 사용하고 @impact7/shared 계약을 우선 확인하라.
3. Phase 1 보안 차단부터 진행하라.
4. `06-test-writing-guide.md`의 테스트 매트릭스를 따라 실패하는 회귀 테스트를 먼저 추가하라.
5. Firestore/Storage rules 변경에는 반드시 emulator regression test를 먼저 추가하라.
6. 테스트가 현재 취약 동작에서 실패하는 것을 확인한 뒤 구현을 수정하고 다시 통과시켜라.
7. 운영 배포는 하지 말고 로컬 구현과 검증까지만 완료하라.
8. 기존 unrelated 변경은 건드리지 마라.
9. 각 finding을 수정할 때 원인, 수정 파일, 테스트 결과, 남은 위험을 기록하라.
10. 소스 코드 커밋 전 simplify → code-review를 수행하고 품질 guard marker를 기록하라.
11. Phase별로 작은 커밋이 가능한 상태로 분리하되, 내가 요청하기 전에는 commit/push하지 마라.

최우선 완료 기준:
- exam_users 자기 role 상승 차단
- 공개 HR token list/get 차단
- 비인증 staff/employee/contract get 차단
- Storage HR 권한 최소화
- llmGenerate 직원 인증
- 위 항목의 허용/거부 테스트 통과
```

## 진행 보고 형식

```text
현재 Phase:
수정한 finding:
변경 파일:
검증 명령과 결과:
남은 blocker:
다음 작업:
```

## `write test @filename` 사용 예

`write test @filename`은 특별한 필수 명령이 아니라, `@filename`으로 대상 파일을 Claude의 컨텍스트에 넣고 그 파일에 대한 테스트를 작성하라는 자연어 요청이다.

이번 작업에서는 다음처럼 구체적으로 요청한다.

```text
@firestore.rules
@docs/codex review/2026-06-21-impact7db-comprehensive-review/06-test-writing-guide.md
C-01부터 C-03까지 현재 취약 규칙에서 실패하는 Firestore emulator 회귀 테스트를 먼저 작성해줘.
아직 rules 구현은 수정하지 말고, 테스트 실패 원인과 실행 명령을 보고해줘.
```

그다음 구현 수정 요청:

```text
방금 작성한 실패 테스트를 통과하도록 firestore.rules를 최소 범위로 수정해줘.
전체 rules 테스트도 실행하고 허용/거부 케이스가 모두 통과하는지 보고해줘.
```
