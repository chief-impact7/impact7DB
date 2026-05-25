---
name: feedback-history-classifier-sync
description: 수업이력 분류기(_classifyHistory 7종)는 DB와 DSC 비원생 수업이력에서 동일 유지 — 한쪽 수정 시 항상 양쪽 동기화
metadata:
  type: feedback
---

수업이력 분류 로직(`_classifyHistory` + `_parseStatusClass` + `_shortAuthor` + `HISTORY_BADGE` + 한 줄 렌더/연속중복제거)은 **impact7DB와 impact7newDSC(비원생 수업이력)에서 동일하게 유지**한다. 한쪽을 고치면 반드시 다른 쪽도 같이 고친다.

**7종 분류:** 신규/휴원/복귀/퇴원/재등원/전반/수업추가. 그 외(요일변경·자동활성화·STATUS_CHANGE 중복·DELETE·PROMOTION 등)는 숨김. 표시는 "이전 → 다음" 한 줄, 작성자는 이메일 `@` 앞만(자동전환·시스템은 `system`).

**Why:** 두 앱이 같은 Firebase 프로젝트(impact7db)의 **같은 `history_logs` 컬렉션**을 공유하므로 데이터 형태가 동일하다. 일선 교사가 양쪽에서 같은 이력을 보도록 사용자가 "DSC에도 동일 적용, 앞으로도 계속 동기화"를 명시적으로 요청함 (2026-05-26). 로직이 갈라지면 같은 학생 이력이 앱마다 다르게 보임.

**How to apply:** 수업이력 분류/표시 관련 수정 요청이 오면 DB(app.js)만 고치고 끝내지 말고 DSC의 대응 파일도 함께 수정한다. 크로스앱 변경이므로 `impact7-orchestrator`로 조율하고, 코드에 "양쪽 동기화" 주석을 유지한다. 분류기는 prod `history_logs` 실데이터로 검증(읽기 전용)한 뒤 배포. 관련: [[feedback-naesin-blank-class-tag]].
