---
name: qbank-ecosystem-pending
description: 보류된 결정 — impact7qbank을 크로스앱 에코시스템 목록에 포함할지. 사용자가 나중에 다시 물어봐 달라고 함
metadata:
  type: project
---

# 보류: impact7qbank 에코시스템 편입 여부

2026-05-27 에코시스템을 7개 앱(DB/DSC/HR/exam/consultation/newtest/dashboard)으로 확장할 때, `impact7qbank`을 포함할지 물었더니 사용자가 **"잠시 보류, 나중에 다시 물어봐 줘"** 라고 함.

**Why:** qbank은 Storage만 공유하고 firestore.rules 파일이 없어(다른 6개와 성격 다름) 즉시 편입 판단을 미룸.

**How to apply:** 에코시스템/qbank 관련 작업이 다시 나오거나, 세션 시작 시 이 항목이 눈에 띄면 "qbank도 에코시스템 목록에 넣을까요?"를 사용자에게 다시 물어볼 것. 결정되면 DB AGENTS.md 하네스 목표/변경이력에 반영(에코시스템 멤버 목록의 SSoT는 AGENTS.md). `CSAT-Vocabulary`는 이번 논의에서 제외됨.

관련: 에코시스템 멤버 목록·cross-ref 설계는 impact7DB `AGENTS.md`의 "## 하네스" 섹션 참조(메모리에 중복 저장하지 않음).
