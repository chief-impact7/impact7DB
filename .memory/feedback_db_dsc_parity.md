---
name: db-dsc-parity
description: DB와 DSC는 동작·로직이 항상 동일해야 한다. 한쪽 변경 시 다른 쪽도 반드시 맞춤
metadata:
  type: feedback
---

# DB ↔ DSC는 항상 동일하게 유지

impact7DB와 impact7newDSC는 **동작·로직이 항상 동일해야 한다.** 한쪽(특히 학생 status/enrollment/진입 모델 등 공유 개념)을 바꾸면 **반드시 다른 쪽도 동일하게 맞춘다.**

**Why:** 두 앱이 같은 Firebase 프로젝트·같은 students 컬렉션·같은 Cloud Function(leave-request)·같은 공유모듈(@impact7/shared)을 쓰는 한 몸 에코시스템. 한쪽만 바뀌면 데이터/UX 불일치가 생김. 사용자가 2026-05-28 "db와 dsc는 항상 동일해야 해"로 명시.

**How to apply:**
- DB 또는 DSC의 status/enrollment/진입·전이 로직을 바꾸면 반대쪽도 점검·동기화. "DB만 했다"로 끝내지 말 것.
- 단, **이미 공유로 통일된 지점은 한 곳만 바꾸면 양쪽 적용됨**: 복귀/재등원 status 전이=Cloud Function `buildUpdate.js`(공유), 등원예정→재원=`promoteEnrollPending`(공유), 정합성/tone/전이규칙=`@impact7/shared/enrollment-status`. 이런 건 공유 소스 한 곳 수정.
- 진짜 분기되는 곳(각 앱 UI/폼)만 양쪽 따로 맞춤. 예: 진입 모델 통일 시 — DB는 신규등록 폼 기본값을 등원예정으로, DSC는 첫데이터입력이 '상담'으로 생성(이미 정합, prospect=비원생)이라 둘 다 "재원 직접진입 없음"으로 일치.

관련: [[student-display-unification]], [[feedback_history_classifier_sync]], [[feedback_rules_sync_commit]]
