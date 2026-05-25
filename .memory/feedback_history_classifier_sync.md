---
name: feedback-history-classifier-sync
description: 수업이력 분류기(7종)는 공유 모듈 @impact7/shared/history 단일 소스 — DB·DSC가 import. 분류 로직은 공유 repo에서만 수정
metadata:
  type: feedback
---

수업이력 분류 로직(`classifyHistory` + `parseStatusClass` + `shortAuthor` + `HISTORY_BADGE`)은 **공유 npm 패키지 `@impact7/shared`(repo: `chief-impact7/impact7-shared`, public)의 `history-classifier.js`** 한 곳에 있다. impact7DB(app.js `renderHistory`)와 impact7newDSC(class-history.js 비원생 수업이력)가 `import { classifyHistory, HISTORY_BADGE, shortAuthor } from '@impact7/shared/history'`로 가져다 쓴다. (2026-05-26 복붙 손동기화 → 공유 모듈로 전환. 파일럿.)

**7종 분류:** 신규/휴원/복귀/퇴원/재등원/전반/수업추가. 그 외(요일변경·자동활성화·STATUS_CHANGE 중복·DELETE·PROMOTION 등)는 숨김. 표시("이전 → 다음" 한 줄, 작성자 `@`앞만)·연속중복제거·날짜포맷·DOM은 각 앱의 렌더 함수가 담당(공유 안 함).

**Why:** 두 앱이 같은 Firebase 프로젝트(impact7db)의 **같은 `history_logs` 컬렉션**을 공유해 데이터 형태가 동일. 예전엔 분류기를 양쪽에 복붙하고 손으로 맞췄는데, 앱이 늘며 "양쪽 똑같이 고치기"가 부담 → 중복 제거를 위한 첫 공유 모듈 파일럿. repo가 public이라 `npm i github:chief-impact7/impact7-shared#<tag>`가 CI 토큰 없이 동작.

**How to apply:** 분류 로직을 바꾸려면 **`impact7-shared` repo에서만 수정** → 테스트(`node --test`, 8케이스) → 새 태그 push → DB·DSC 양쪽에서 dep 버전 올리고 `npm i` 후 커밋. 절대 app.js/class-history.js에 분류기를 다시 인라인하지 말 것. 분류기는 prod `history_logs` 실데이터로 검증(읽기 전용)한 뒤 배포. 관련: [[feedback-naesin-blank-class-tag]].
