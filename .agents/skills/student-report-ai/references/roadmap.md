# 학생 AI 리포트 로드맵

origin: student-report/PLAN.md에서 이관 (2026-06-13).

## 완료된 단계

1. [x] Google Chat API + DWD 설정 (DWD 승인·동작 확인)
2. [x] Cloud Function `generateStudentReportAi` 구현 (Firebase+Gemini)
3. [x] DSC student-detail 종합 요약 카드
4. [x] 상담 AI + 종합상태 AI 단일 콜러블 통합 (Gemini 2회→1회) + 상담 공백 경고
5. [x] Chat 언급 graceful 연동 (DWD chief@ 가장, 학생이름 매칭)

## 남은 단계

### 6. Chat 동기화 최적화 ← 다음 우선
**문제**: 리포트 1건마다 chief 전 스페이스를 풀스캔해 느리고 Chat API 쿼터를 소모(현재 on-demand).
**최적화안**: scheduled function이 신규 Chat 메시지를 Firestore `chat_messages`(학생이름 태깅)에 주기 적재 → 리포트는 `chat_messages` 인덱스 조회만. 풀스캔을 주기 1회로 분산, 리포트 응답 즉시화.
**설계 결정 필요**: 적재 시점 학생 이름 매칭 기준(동명이인 처리 — 반/학년 보정 등).

### 7. 월간 리포트 생성 및 공유 방식 결정
- 리포트 형식(학생별 월말 요약)과 공유 채널(이메일/Drive/학부모 메시지 등) 결정.
- `generateStudentReportAi`의 종합 결과를 월 단위로 집계·정리.

### 8. 리포트 자동화 (월 1회 scheduled function)
- 5(7번 결정)에서 정한 형식·채널을 `onSchedule`로 매월 1일 전체 재원생 순회 생성·공유.
- 6번 결정이 선행돼야 의미. functions-developer가 `onSchedule` 패턴으로 구현.

## 인프라 요약

- AI: Gemini (`gemini-3.1-pro-preview`), `functions-shared/src/vertex.js` 경유 Vertex
- Auth: DWD(서비스 계정 chief@ 가장), `@impact7.kr` 직원만 callable 호출
- 저장: `student_status_summaries` / `consultation_summaries` / `consultation_briefings`
- 공유 방식: 미정 (단계 7에서 결정)
