---
name: student-report-ai
description: "impact7 학생 AI 종합 리포트 도메인 지식. 학생별 출결·숙제·테스트·상담·Chat을 Gemini로 종합하는 generateStudentReportAi, 종합상태 카드, 상담 요약/브리핑, 상담 공백 경고, Chat(DWD) 연동, 월말 리포트·자동화를 다룰 때 반드시 사용. 이 도메인의 데이터 모델 함정(중첩 attendance.status, 한국어 status값)과 AI 콜러블 무중단 배포 순서를 담는다. 학생 리포트 기능 추가·수정·보완·재실행, 월말 리포트, Chat 동기화 작업 시에도 사용."
---

# 학생 AI 종합 리포트 도메인

impact7DB `functions-shared` 백엔드 + impact7newDSC 프론트에 걸친 "학생 AI 종합 리포트" 도메인의 지식. functions-developer·dsc-developer가 이 영역을 작업할 때 참조한다.

**목표**: Firebase(DSC) 출결·숙제·테스트·상담 + Google Chat 메시지를 Gemini로 종합 → 학생별 종합상태·상담요약·다음상담 브리핑·월말 리포트.

## 핵심 함수: `generateStudentReportAi`

- 핸들러: `functions-shared/src/studentReportAiHandler.js` (callable, index.js 등록)
- 데이터 **1회 수집**(프로필·출결·결석·숙제·테스트·상담·Chat) + Gemini **1회 호출** → 종합상태·상담요약·브리핑을 한 JSON으로 생성
- 결과를 기존 **3개 컬렉션에 분산 저장**해 UI는 무변경:
  - `student_status_summaries/{id}` — 종합상태(status good/caution/risk, summary, risk_flags, action_items, *_comment, consultation_gap_*, chat_mention_count)
  - `consultation_summaries/{id}` — 상담 누적요약(summary_markdown, priority, notable_topics)
  - `consultation_briefings/{id}` — 다음상담 브리핑(briefing_markdown, recommended_next_actions)
- 모델: `gemini-3.1-pro-preview`. AI 호출은 `src/vertex.js`의 `generateText`.
- 구 콜러블 `generateStudentConsultationAi`·`generateStudentStatusAi`는 이 함수로 **통합·삭제됨**(다시 만들지 말 것).

## ⚠️ 데이터 모델 함정 (버그 다발 — 반드시 확인)

이 도메인의 Firestore 필드는 직관과 다르다. 코드 작성 전 실제 쓰기 코드와 대조하라.

| 항목 | 올바른 접근 | 흔한 오류 |
|------|-------------|----------|
| 출결 상태 | **중첩** `r.attendance?.status` | 평면 `r.attendance_status` (항상 undefined → 통계 0) |
| 출결 값 | `출석`/`결석`/`지각`/`조퇴`/`미확인` | `외출` 등 없는 값 추측 |
| 등원 판정 | `출석`·`지각`·`조퇴` (`isAttendedStatus`) | 전체를 등원으로 셈 |
| hw/test task status | 한국어 `pending`/`완료`/`취소`/`기타` | 영어 `completed` (항상 0) |

검증 출처: `impact7newDSC/attendance.js`(attendance.status·isAttendedStatus), `hw-management.js`/`daily-ops.js`(status 한국어값).

## 데이터 소스 / 인덱스

| 컬렉션 | 내용 | 조회 전략 |
|--------|------|----------|
| `daily_records` | 출결·수업 | 서버 range+정렬(복합 인덱스 `student_id`+`date DESC`) |
| `absence_records`/`hw_fail_tasks`/`test_fail_tasks` | 결석·숙제미제출·테스트미달 | equality-only(`student_id`) 후 메모리 cutoff(신규 인덱스 회피) |
| `consultations` | 상담 | 기존 `student_id`+`date DESC` 인덱스 |

`firestore.rules`: 산출물 3컬렉션은 서버 전용 쓰기(`write: if false`)+인증 읽기. rules 변경 시 `firestore-rules-sync`로 4개 프로젝트 동기화(줄바꿈 보존 cp).

## 상담 공백 경고 (코드에서 결정론적 계산, AI 비의존)

최근 상담일과 `todayKST()`의 일수 차이를 계산 → 30일 초과(또는 상담 0건)면 `consultation_gap_warning=true`. 카드에 ⚠️ 배너. AI 출력이 아니라 코드로 계산해야 정확하다.

## UI (DSC 프론트)

- `student-status-card.js` — daily 탭 최상단 종합상태 카드(양호/주의/위험 배지, 5종 스탯, 공백 경고)
- `consultation-card.js` — 상담 탭 요약/브리핑 카드
- 두 카드의 [AI 생성] 버튼 **모두 `generateStudentReportAi` 호출** → 어디서 눌러도 3컬렉션 갱신. 다른 탭은 다음 열람 시 반영.

## AI 콜러블 무중단 배포 순서

콜러블 시그니처 변경·교체·삭제 시 (functions-developer 참조):
1. 새 함수만 배포 → 2. DSC 프론트 배포 → 3. 구 함수 삭제(`functions:delete --force`)

## Chat 연동 (DWD)

선생님 Chat 언급을 종합에 포함. 상세·운영값은 `references/chat-integration.md` 참조. 핵심 함정:
- `orderBy`는 **대문자 `createTime DESC`** (소문자면 400 → graceful이 삼켜 조용히 0건)
- DWD 미설정·실패 시 graceful skip(Chat 없이 진행). 배포 후 실제 1회 스모크 검증 필수
- 이름 매칭은 `text.includes(name)` — 동명이인/부분문자열 오탐 가능(프롬프트 주의문구로 완화)

## 자동화 함수 (전체 재원생 일괄/자동 생성, 2026-06-14 배포)

전체 재원생(500+) AI 리포트를 자동/일괄 생성한다. 1명 로직은 `studentReportAiHandler.js`의 순수 함수 `generateReportForStudent({firestore, generateWithUsage, getChat, today, studentId, actor})`를 재사용(콜러블·일괄 공용). 비용 추적은 `vertex.generateTextWithUsage`(usageMetadata 반환), 단가 상수는 추정치.

- **`studentReportBatch.js` `runStudentReportChunk`**: 한 호출 = 한 청크. **타임박스(`MAX_RUN_MS` 8분) + 커서 재개**로 540s timeout 회피.
- **상태(`automation_settings/student_report`) — 두 플래그 분리 (헷갈리면 버그)**:
  - `batch_active`: 배치 시작+pending 남음(여러 청크 지속). `chunk_lock`+`run_started_at`: 지금 청크 처리 중인 작업자 락(트랜잭션 claim, stale 30분 탈취).
  - 대상은 첫 청크에서 `run_pending_ids`로 **고정**(재개 시 skip 재평가 안 함 — 진행 중 방금 생성분이 빠지는 것 방지). 누적값(`run_generated`/`run_*_tokens` 등)도 상태에 저장.
  - `last_run_at`은 **완료 시점에만** 기록 → 크래시 슬롯은 미완료로 남아 재시도됨.
- **`runStudentReportAutomation`(onSchedule `*/5` KST)**: batch_active면 이어받기, 아니면 `scheduleMatches`(catch-up `hour>=run_hour`, daily/weekly/monthly) && !`alreadyRanThisSlot`(완료일 기준)이면 새 시작. locked면 skip.
- **`runStudentReportBatchManual`(callable, director↑=HR_users.role)**: 첫 청크 즉시. 미완료분은 5분 틱이 이어받음. 반환 `{ok, status:'in_progress'|'complete', done, total}` | `{ok:false, reason:'locked'}`. UI는 `progress_done`/`progress_total`/`batch_active` onSnapshot 구독.
- **함정**: rules `automation_settings` allowlist엔 클라 patch 필드(enabled/interval/run_day/run_hour/skip_within_days)만. 서버 필드(batch_active/chunk_lock/run_*)는 admin SDK 우회. `run_pending_ids`는 문서 1MB 한도 — 1만명+면 커서 방식 전환.

## 로드맵 (남은 작업)

다음 단계와 인프라 상세는 `references/roadmap.md` 참조: 단계 6~8 완료, 월간 리포트 **공유** 채널(단계 9)이 다음 우선.

## 테스트

`functions-shared/test/`의 `studentReportAiHandler.test.js`(인증·3컬렉션·상담0·30일·Chat graceful), `studentReportBatch.test.js`(청크 분할·재개 누적·락 충돌·stale 탈취·크래시·skip 고정), `studentReportAutomation.test.js`(catch-up·슬롯 중복·권한). 모두 vitest deps 주입.
