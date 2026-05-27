---
name: new-status-deferred
description: 보류된 계획 — '등원예정→신규' status 일원화 + 신규현황 대시보드. 결론은 status 마이그레이션 불필요
metadata:
  type: project
---

# 보류: '신규' status 일원화 + 신규현황 대시보드 (2026-05-28 보류)

사용자가 (1) 입력 시 등원예정/재원을 잘못 고르는 휴먼에러를 없애려 "신규" 하나로 일원화, (2) DashBoard로 일일/누적 신규현황 집계를 검토하다 **당분간 보류**("문제 생기면 다시 말해줄게").

**Why 보류 / 핵심 판단 (재논의 시 이 결론에서 출발):**
- **신규현황 대시보드는 이미 `ENROLL` 이벤트(history_logs) 기반으로 집계**됨 (DashBoard `metrics.ts` `countEvents(ctx, period, 'ENROLL')`, App.tsx "신규생 유입 현황/추이"). status 스냅샷이 아니라 날짜 박힌 이벤트라 이게 올바른 기반.
- 따라서 분석 목적엔 **"신규" status 불필요·오히려 부적합** — 등원예정은 start_date≤오늘이면 즉시 재원 전환(promoteEnrollPending)이라 status="신규"로 세면 당일 신규를 과소집계함.
- 신규현황 정확도의 진짜 관건 = **모든 신규 등록 경로의 ENROLL 로그 완전성** (2026-05-26에 DSC 반편성 마법사·수동등록 갭 보강함). 숫자가 비거나 틀리면 그 로그 누락을 추적할 것.

**How to apply:** 이 주제 재개 시 status 값 마이그레이션부터 제안하지 말 것. 입력 UX 단순화(선택지 "신규" 1개→등원예정 저장)는 마이그레이션 없이 가능한 별개 작업(A안: 공유모듈 selectableStatuses/INITIAL_STATUSES + 폼 라벨). 표시 단어까지 "신규"여야 할 때만 값 마이그레이션(rules enum+공유모듈+전수 배치, 고비용) 검토.

관련: [[student-display-unification]](공유모듈 enrollment-status), [[qbank-ecosystem-pending]](또다른 보류건)
