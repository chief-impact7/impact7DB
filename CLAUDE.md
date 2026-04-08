# Claude Code - impact7DB 프로젝트 설정

## 코드 품질 관리
- 빌드 완성 후 커밋 전에 `/simplify`를 실행하여 코드를 정리한다
- 큰 변경(여러 파일, 인증/보안 관련) 시 푸시 전에 `/code-review` 실행을 권장한다
- 푸시하면 Actions로 자동 배포되므로, 푸시 전 점검이 마지막 안전장치다

## 메모리 (계정 공유)

1인 개발. 여러 Claude 계정을 번갈아 사용하지만 동일 사용자.
작업 기록/피드백은 **이 프로젝트 폴더 안** `.memory/`에 저장한다.
계정별 `~/.claude-*/projects/*/memory/`에 저장하지 말 것.

- 새 대화 시작 시: `.memory/MEMORY.md` 먼저 읽을 것
- 메모리 저장 시: `.memory/`에 파일 생성하고 `.memory/MEMORY.md` 인덱스 업데이트

