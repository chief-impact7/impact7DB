---
name: feedback-naesin-blank-class-tag
description: 내신 기간 중 정규반 태그가 빈칸으로 나오는 건 의도된 동작 — naesin_class_override로 채우지 말 것
metadata:
  type: feedback
---

내신 기간 중인 학생의 반 태그가 `—`(빈칸), 반별 그룹에서 `미지정`으로 보이는 것은 **버그가 아니라 의도된 동작**이다. `naesin_class_override`(예: "2단지강서고1A")로 채우는 변경은 하지 말 것.

**메커니즘:**
- `getActiveEnrollments` (app.js:274-281): 활성 내신이 있으면 정규 enrollment를 결과에서 제거 → 내신 종료일 후 정규 복귀.
- 내신 enrollment는 `level_symbol`/`class_number`가 빈 값 (정상 설계, app.js:2738 검증에서 내신에 코드 있으면 에러). 대신 `naesin_class_override`를 쓰는데 **impact7DB app.js는 이 필드를 표시에 안 씀** (DSC만 소비).
- 결과: `activeClassCodes(s)`가 빈 배열 → 반 태그 빈칸. 정규반 데이터는 살아있고 내신 종료일 지나면 자동 복귀.

**Why:** 2026-05-26 강우영/구선우 사례에서 "내신 중에는 빈칸으로 두는 현재 동작이 더 낫다"고 사용자가 명시적으로 선택함 (naesin_class_override 표시 제안을 거절).

**How to apply:** 내신 기간 중 빈 반 태그/미지정 그룹을 보고 데이터 손상이나 표시 버그로 진단하지 말 것. 정규반은 enrollments에 그대로 있으며 내신 end_date 이후 복원된다.
