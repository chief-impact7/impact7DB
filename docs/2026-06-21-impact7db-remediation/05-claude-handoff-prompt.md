# 실행 에이전트 전달용 지시문

아래를 실행 세션(Claude Code / Codex)에 전달한다.

```text
이 저장소의 검증·보완된 종합 리뷰 작업폴더를 읽고 수정 작업을 진행해줘.

작업폴더 (절대경로 — 폴더명에 공백 없음):
@/Users/jongsooyi/IMPACT7/impact7DB/docs/2026-06-21-impact7db-remediation/00-verification-log.md
@/Users/jongsooyi/IMPACT7/impact7DB/docs/2026-06-21-impact7db-remediation/02-findings.md
@/Users/jongsooyi/IMPACT7/impact7DB/docs/2026-06-21-impact7db-remediation/03-validation-evidence.md
@/Users/jongsooyi/IMPACT7/impact7DB/docs/2026-06-21-impact7db-remediation/04-remediation-plan.md
@/Users/jongsooyi/IMPACT7/impact7DB/docs/2026-06-21-impact7db-remediation/06-test-writing-guide.md

요구사항:
1. 먼저 AGENTS.md와 .memory/MEMORY.md를 읽어라.
2. codegraph_explore를 먼저 쓰고 @impact7/shared 계약을 우선 확인하라.
3. Phase 1 보안 차단부터. 단, 04-remediation-plan.md의 ⚠크로스앱 선결조건을 반드시 지켜라:
   공개 토큰 read·직원/계약 get·Storage HR 경로를 닫기 전에 HR 앱의 비인증 플로우를
   callable 경유로 먼저 이전해야 한다. rules만 단독으로 닫지 마라.
4. 06-test-writing-guide.md 매트릭스대로 실패하는 회귀 테스트를 먼저 추가하라(신규 N-01·N-02 포함).
5. Firestore/Storage rules 변경에는 반드시 emulator regression test를 먼저.
6. 테스트가 현재 취약 동작에서 실패하는 것을 확인한 뒤 구현 수정·재통과.
7. 운영 배포 금지. 로컬 구현·검증까지만.
8. 무관한 기존 변경은 건드리지 마라.
9. 각 finding마다 원인·수정 파일·테스트 결과·잔존 위험 기록.
10. 소스 코드 커밋 전 simplify → code-review 후 quality guard marker 기록.
11. Phase별 작은 커밋 단위 유지. 내가 요청하기 전엔 commit/push 금지.
12. 대량 batch Firestore 작업은 사용자 승인 후에만(메모리 규율).

최우선 완료 기준:
- exam_users 자기 role 상승 + 외부 도메인 접근 차단 (C-01·N-01)
- exam_analyses 외부 read 차단 (N-01)
- 공개 HR token list/get 차단 + 토큰→PII 체인 차단 (C-02·C-03·N-02)
- Storage HR 권한 최소화 (H-01)
- llmGenerate 직원 인증 + rate limit, callable App Check (H-02·N-05)
- 위 항목 허용/거부 테스트 통과
- Functions 배포 게이트(validate→deploy) + lockfile/npm ci (H-06·M-07)
```

## 진행 보고 형식

```text
현재 Phase:
수정한 finding:
변경 파일:
검증 명령과 결과:
크로스앱 영향(HR/DSC/exam):
남은 blocker:
다음 작업:
```

## 신규 발견 우선 처리 메모

Codex 1차 리뷰에는 없던 신규 발견을 빠뜨리지 말 것:
- **N-01** 외부 도메인 계정의 exam_analyses/exam_users 접근 (C-01과 함께 닫기)
- **N-02** 공개 토큰 → staffId/contractId → 공개 get PII 체인 (C-02·C-03 함께)
- **N-05** 전 callable App Check 부재
- **N-03** update-shared.yml 루트만 bump
- **N-06~N-08** syncNaesinPeriod 비원자 / 일괄 status 메타 누락 / 문법특강 phantom 상태

## 과대평가였던 항목 (시간 배분 주의)

- **H-03**은 `allStudents`가 store와 alias라 위험 낮음 → `currentStudentId` 미러 누락만 가볍게 정리. 대규모 리팩토링 불필요.
- **O-05**의 ~625KB·번들 경고는 미검증/과장 → 비모듈 help-guide 정리만(O-03과 함께).
