# Handoff Prompt

아래 프롬프트를 다음 에이전트에게 그대로 전달하면 된다.

```text
작업 위치: /Users/jongsooyi/IMPACT7/impact7DB

먼저 AGENTS.md, .memory/MEMORY.md, .memory/reference_codegraph_guide.md를 읽고, codegraph_explore를 먼저 사용해 현재 코드를 확인해라.

이번 감사 문서:
/Users/jongsooyi/IMPACT7/impact7DB/docs/codex review/2026-07-04-impact7db-comprehensive-review/README.md

목표:
01~04 문서의 findings 중 Phase 1부터 처리한다. 관련 없는 파일은 건드리지 않는다.

우선순위:
1. root/functions/functions-shared runtime npm audit 실패를 정리한다.
2. .github/workflows/deploy-functions.yml의 Cloud Run public invoker 복구를 allowlist/label 기반으로 좁힌다.
3. functions/package.json의 test script를 emulator 계약과 맞춘다.
4. App Check rollout은 공개 토큰 callable 예외와 직원 전용 callable을 분리한 뒤 작은 그룹부터 적용한다.

검증:
- npm run build
- npm run check:shared
- npm test
- npm run test:storage
- cd functions && npm run lint
- cd functions && firebase emulators:exec --only firestore --project demo-impact7 "npx vitest run"
- cd functions-shared && npm test
- 각 패키지 npm audit --omit=dev
- git diff --check

주의:
- impact7DB는 Firestore/Storage rules SSoT다.
- storage/functions 배포는 이 repo 규칙을 따른다. firebase deploy --only functions 전체 배포는 피한다.
- source code 수정 후 commit 전에는 AGENTS.md의 simplify/review 품질 절차와 precommit marker 규칙을 따른다.
- 기존 untracked .omc/와 docs/codex review/는 사용자/이전 작업 산물일 수 있으니 삭제하지 않는다.
```
