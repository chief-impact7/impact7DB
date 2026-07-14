---
name: reference-codegraph-guide
description: codegraph 인덱스 현황 + 도메인별 핵심 쿼리 패턴 — 이 프로젝트에서 코드를 탐색할 때 먼저 확인
metadata:
  type: reference
---

# impact7DB codegraph 활용 가이드

**인덱스 현황 (2026-06-09 기준)**
- 파일 80개 · 노드 957개 · 엣지 1,660개 · DB 2.16 MB
- 언어: JavaScript 78, YAML 2
- WAL 모드 — 동시 읽기 안전

## 구조 개요

```
app.js / daily-ops.js  — 메인 SPA (모듈 분리 진행 중)
store.js               — 공유 상태 단일 진실 원천
functions/             — Cloud Functions (leave-request codebase)
functions-shared/      — 공유 백엔드 (shared codebase: llmGenerate, 카카오·결제 골격)
scripts/               — Firestore 관리 스크립트 (upsert, cleanup, oneoff)
```

## 도메인별 codegraph_explore 핵심 쿼리

| 도메인 | 쿼리 예시 |
|-------|----------|
| 학생 상태·재원·이력 | `"student status enrollment history-classifier enrollment-status"` |
| 숙제·테스트 기록 | `"homework test dailyRecord saveImmediately dailyRecords"` |
| 반 이동·승격 | `"class-move promote-enroll classMove enrollmentCode"` |
| 학생 표시·매칭 | `"studentFullLabel studentShortLabel student-label student-number"` |
| 공유 상태 store | `"store allStudents update activeFilters currentStudentId"` |
| Cloud Functions (leave-request) | `"onLeaveRequestApproved leaveRequest reEnroll"` |
| Cloud Functions (shared) | `"llmGenerate consultationAiHandler vertex generateText"` |
| Firebase Admin 스크립트 | `"upsertStudents cleanup-enrollments initFirebase adminDb"` |
| Firestore 규칙 | `"firestore.rules students allow write delete"` |
| @impact7/shared 연동 | `"impact7-shared history-classifier enrollment-derivation shared"` |

## 주요 모듈 위치

| 파일 | 역할 |
|------|------|
| `store.js` | 전역 상태 (allStudents, activeFilters, dailyRecords 등) |
| `app.js` | 메인 SPA 진입점 (분리 진행 중) |
| `daily-ops.js` | 일별 운영 로직 (분리 완료된 것) |
| `hw-management.js` | 숙제 관리 (분리 완료) |
| `parent-message.js` | 학부모 메시지 생성 |
| `functions/index.js` | leave-request Cloud Function |
| `functions-shared/src/consultationAiHandler.js` | AI 게이트웨이 |
| `upsert-students.js` | 학생 데이터 일괄 upsert |

## @impact7/shared 우선 탐색 원칙

학생 상태·이력·반이동·승격·매칭 관련 작업 전, 로컬 구현보다 먼저 확인:
```
/Users/jongsooyi/IMPACT7/impact7-shared/package.json  — export map
```
핵심 shared 모듈: `history-classifier`, `enrollment-status`, `enrollment-derivation`,
`class-move`, `promote-enroll`, `student-number`, `student-label`

## Firestore 컬렉션

| 컬렉션 | 설명 |
|--------|------|
| `students` | 학생 마스터 (에코시스템 공유, 삭제 차단) |
| `daily_records` | 일별 수업 기록 |
| `class_settings` | 반 설정 |
| `history_logs` | 변경 이력 |
| `daily_stats` | 일별 통계 |
| `leave_requests` | 휴·퇴원 요청 |

## Cloud Functions 배포 주의

```bash
# shared codebase만 배포
firebase deploy --only functions:shared --project impact7db
# leave-request codebase만 배포
firebase deploy --only functions:leave-request --project impact7db
# 절대 금지: firebase deploy --only functions  (두 codebase 동시 배포)
```

## 주의: 테스트 없음

모든 심볼에 "no covering tests found" — 변경 시 런타임 검증 필수.
