# Claude Code - impact7DB 프로젝트 설정

## 코드 품질 관리
- 빌드 완성 후 커밋 전에 `/simplify`를 실행하여 코드를 정리한다
- 큰 변경(여러 파일, 인증/보안 관련) 시 푸시 전에 `/code-review` 실행을 권장한다
- 푸시하면 Actions로 자동 배포되므로, 푸시 전 점검이 마지막 안전장치다

## app.js 모듈 분리 규칙 (2026-04-12 결정)

impact7DB는 에코시스템의 마스터 데이터 허브이므로 app.js(현재 ~6000줄)를 점진적으로 분리한다.

**규칙 1 — 새 기능은 별도 모듈로 작성한다**
- `app.js`에 코드를 추가하지 않는다
- 별도 `.js` 파일을 만들고, 공유 상태는 `app.js`에서 export하여 import한다
- `window.*` 함수 등록은 모듈 파일 안에서 한다

**규칙 2 — 기존 코드는 수정할 때 분리한다**
- 기존 블록을 수정해야 할 때, 그 블록을 별도 파일로 분리한다
- 안 건드리는 코드는 그냥 둔다 (리스크 없는 점진적 축소)

**분리 우선순위** (독립성 높은 순):
1. 패널 리사이저 (~35줄) — 공유 상태 참조 0
2. 일별 통계 (~230줄) — currentUserRole만 참조
3. 내신 시간표 (~380줄) — allStudents, activeFilters 읽기
4. 문법 특강 (~550줄) — allStudents 읽기/쓰기
5. 휴퇴원요청서, Google Sheets, 일괄처리 — 공유 상태 깊이 의존

**주의:** allStudents 배열을 직접 mutate하는 블록은 state 접근 패턴을 먼저 정리해야 분리 가능. 상세 분석은 `.memory/feedback_module_separation.md` 참조.

## 메모리 (계정 공유)

1인 개발. 여러 Claude 계정을 번갈아 사용하지만 동일 사용자.
작업 기록/피드백은 **이 프로젝트 폴더 안** `.memory/`에 저장한다.
계정별 `~/.claude-*/projects/*/memory/`에 저장하지 말 것.

- 새 대화 시작 시: `.memory/MEMORY.md` 먼저 읽을 것
- 메모리 저장 시: `.memory/`에 파일 생성하고 `.memory/MEMORY.md` 인덱스 업데이트

## 하네스: impact7 에코시스템 통합 운영

**목표:** DB/DSC/HR/exam 4개 앱에 걸친 크로스앱 개발 작업을 안전하게 조율

**트리거:** 크로스앱 변경, 공유 컬렉션 수정, 다중 앱 기능 개발 요청 시 `impact7-orchestrator` 스킬을 사용하라. 단일 앱 내 소규모 변경이나 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-04-12 | 초기 구성 | 전체 | 에코시스템 통합 운영 하네스 구축 |
| 2026-04-12 | cross-app-analysis ↔ impact-analyst 중복 해소 | agents/impact-analyst.md, skills/cross-app-analysis | 위험도 판정표·분석절차를 에이전트로 통합, 스킬은 얇은 트리거로 축소 |
| 2026-04-12 | app.js 모듈 분리 규칙 추가 | CLAUDE.md, agents/db-developer.md, skills/impact7-orchestrator | 새 기능은 별도 모듈, 기존 코드는 수정 시 분리 |

