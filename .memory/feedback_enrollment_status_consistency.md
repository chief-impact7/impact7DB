---
name: feedback-enrollment-status-consistency
description: enrollment↔status 정합성(재원계열만 enrollment 보유)은 @impact7/shared/enrollment-status 단일소스 + firestore.rules 서버 양쪽 강제. 수정은 공유 repo + Rules 4-repo 동시
metadata:
  type: feedback
---

학생 status와 enrollment(반배정)는 배타 정합성을 가진다: **재원 계열(재원/등원예정/실휴원/가휴원)만 enrollment 보유 가능, 비재원(상담/퇴원/종강)은 enrollment가 비어야** 한다.

**단일 소스:** `@impact7/shared/enrollment-status` (repo: chief-impact7/impact7-shared, v1.3.0+). `isEnrollableStatus(status)` / `hasRealEnrollment(enrollments)` / `reconcileEnrollments(status, enrollments)`.

**강제 레이어 3겹:**
1. DB `app.js` 학생 저장 — `reconcileEnrollments`로 비재원이면 enrollment 비우고, 재원계열인데 반 없으면 차단.
2. DSC 반배정(`class-setup.js` 위저드, `daily-ops.js` 학생상세 모달) — `isEnrollableStatus`로 비재원 학생 반배정 차단 + alert.
3. `firestore.rules` students create/update — `enrollmentStatusConsistent()`: `enrollments.size()==0 || status in 재원계열`. 4-repo(DB/DSC/HR/exam) 동일.

**Why:** 상담생이 반배정받으며 status 전환이 누락되면(예: DSC 반설정에서 enrollment만 추가) "상담인데 정규 enrollment 보유" 오염 발생 → DSC 검색/분류가 깨지고(상담생이 정규로 둔갑), 출결 보드에 잘못 노출. 2026-05-27 신혜원(상담+유효 HA104)·김도영2(상담+만료) 등 132명 정리하며 발견. 클라 경로가 여러 개라 서버(Rules)까지 3겹으로 막음.

**How to apply:** 정합성 조건(재원계열 목록 등)을 바꾸려면 ① `impact7-shared`의 `enrollment-status.js` 수정 → 테스트(`node --test`) → 새 태그 → DB·DSC `npm i`(github 캐시 때문에 `rm -rf node_modules/@impact7/shared && npm i ...#태그 --force` 필요) ② `firestore.rules`의 `enrollmentStatusConsistent`도 동일하게 수정 → 4-repo 동기화([[feedback-rules-sync-commit]]) → 배포. 한쪽만 고치면 클라/서버 불일치. 관련: [[feedback-history-classifier-sync]].
