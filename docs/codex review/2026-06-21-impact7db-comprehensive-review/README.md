# impact7DB Codex 종합 리뷰

- 리뷰일: 2026-06-21
- 대상: `/Users/jongsooyi/projects/impact7DB`
- 최종 판정: **REQUEST CHANGES**
- 중점: 정합성, 신뢰성, 안정성, 효율성, 운용 편의성
- 변경 사항: 리뷰 과정에서는 소스 코드를 수정하지 않음

## 문서 구성

1. [01-executive-summary.md](./01-executive-summary.md) — 핵심 판정과 우선순위
2. [02-findings.md](./02-findings.md) — 파일·라인 근거가 포함된 상세 발견사항
3. [03-validation-evidence.md](./03-validation-evidence.md) — 실행한 검증과 결과
4. [04-remediation-plan.md](./04-remediation-plan.md) — 권장 수정 순서와 완료 기준
5. [05-claude-handoff-prompt.md](./05-claude-handoff-prompt.md) — Claude Code에 바로 전달할 작업 지시문
6. [06-test-writing-guide.md](./06-test-writing-guide.md) — `write test @filename` 의미와 finding별 테스트 작업표

## Claude Code에서 여는 방법

다음처럼 이 문서를 컨텍스트로 전달한다.

```text
@docs/codex review/2026-06-21-impact7db-comprehensive-review/README.md
이 리뷰 문서와 연결된 파일을 모두 읽고, 04-remediation-plan.md 순서대로 수정해줘.
```

경로의 공백 때문에 참조가 잘 안 되면 절대경로를 사용하거나 파일을 하나씩 지정한다.

```text
@/Users/jongsooyi/projects/impact7DB/docs/codex review/2026-06-21-impact7db-comprehensive-review/05-claude-handoff-prompt.md
```
