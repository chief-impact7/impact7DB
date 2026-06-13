# 학생 AI 리포트 로드맵

origin: student-report/PLAN.md에서 이관 (2026-06-13).

## 완료된 단계

1. [x] Google Chat API + DWD 설정 (DWD 승인·동작 확인)
2. [x] Cloud Function `generateStudentReportAi` 구현 (Firebase+Gemini)
3. [x] DSC student-detail 종합 요약 카드
4. [x] 상담 AI + 종합상태 AI 단일 콜러블 통합 (Gemini 2회→1회) + 상담 공백 경고
5. [x] Chat 언급 연동 (DWD chief@ 가장, 학생이름 매칭)
6. [x] Chat 동기화 최적화 — syncChatMessages(하루 1회) 적재 + array-contains 인덱스 조회

**6 구현 결과**: scheduled function `syncChatMessages`가 chief 스페이스 신규 메시지를 증분 수집 → 재원생 이름 태깅(번호 포함 고유, 정규식 `name+'(?![0-9])'`로 오탐 방지) → `chat_messages`에 적재. `generateStudentReportAi`는 풀스캔 대신 `where student_names array-contains` 인덱스 조회. 첫 동기화 198건 적재·조회 검증 완료. Chat app Configuration(Console)을 채워야 "Chat app not found"가 해소되는 함정 있었음(chat-integration.md 참조).

7. [x] 리포트 자동화 (타임박스 청크 백엔드) — 아래 "8 구현 결과" 참조

**8 구현 결과 (2026-06-14)**: 전체 재원생(500+) AI 리포트를 자동/일괄 생성하는 백엔드 완성·배포. `generateStudentReportAi`의 1명 로직을 순수 함수 `generateReportForStudent`로 추출해 재사용. **타임박스(8분) + 커서 재개** 청크 모델(`runStudentReportChunk`)로 540s timeout 회피: 한 청크가 시간 예산 내 처리하고 미처리분을 `automation_settings/student_report.run_pending_ids`에 남겨 다음 틱이 이어받는다. `runStudentReportAutomation`(onSchedule 5분, KST interval/run_day/run_hour 매칭 + catch-up), `runStudentReportBatchManual`(callable, director↑). 상세는 SKILL.md "자동화 함수" 참조.

## 남은 단계

### 9. 월간 리포트 공유 방식 (이메일/Drive/학부모 메시지) ← 다음 우선
- 자동 생성된 종합 결과를 월 단위로 집계·정리해 외부로 공유하는 채널 결정·구현.
- 현재는 생성(3컬렉션 저장)까지만 자동화됨. 공유는 미정.

## 인프라 요약

- AI: Gemini (`gemini-3.1-pro-preview`), `functions-shared/src/vertex.js` 경유 Vertex
- Auth: DWD(서비스 계정 chief@ 가장), `@impact7.kr` 직원만 callable 호출
- 저장: `student_status_summaries` / `consultation_summaries` / `consultation_briefings`
- 공유 방식: 미정 (단계 7에서 결정)
