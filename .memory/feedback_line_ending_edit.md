---
name: feedback-line-ending-edit
description: 혼합 CRLF/LF line ending 파일(예: DSC daily-ops.css)을 Edit 도구로 고치면 전체가 정규화돼 대량 가짜 diff 발생 — 바이트 치환으로 보존
metadata:
  type: feedback
---

혼합 CRLF/LF line ending 파일을 Edit/Write 도구로 수정하면 전체 파일이 한 가지 line ending으로 정규화되어, 의도한 2줄 변경이 수백 줄 diff로 부풀어 오른다.

**Why:** impact7newDSC `daily-ops.css`는 git 원본이 CRLF/LF 혼합(`file`로 "with CRLF, LF line terminators")이었는데, Edit 도구가 파일을 다시 쓰며 전체를 순수 CRLF로 통일 → `git diff --stat`이 238줄(127+/123-)로 표시됨. 실제 의도 변경은 2줄. 이대로 커밋하면 파일 전체가 더럽혀지고 blame·협업이 깨진다. (2026-05-27 상담카드 CSS 수정 중 발견)

**How to apply:** line ending이 혼합/CRLF일 수 있는 파일(특히 `.css`)을 수정하기 전후로 점검한다. ① 의심되면 `file <경로>`로 line ending 확인. ② Edit 후 `git diff --stat` 변경 줄 수가 의도와 맞는지 항상 확인 — 부풀었으면 `git diff --ignore-all-space`로 실제 변경 줄 수 대조. ③ 정규화로 오염됐으면 `git checkout HEAD -- <파일>` 원복 후, Python 바이트 치환(`b=open(p,'rb').read(); b=b.replace(b'...라인전체...', b'...새라인...',1); open(p,'wb').write(b)`)으로 line ending 보존하며 특정 라인만 교체. 치환 패턴은 라인 전체를 써서 유일성 보장.
