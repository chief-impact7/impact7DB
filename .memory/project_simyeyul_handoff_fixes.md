---
name: project-simyeyul-handoff-fixes
description: 심예율 케이스 핸드오프 3개 수정 — 소속 csKey 오인·퇴원 수업추가 가드·재원기간 무로그 재등원 보정
metadata:
  type: project
---

# 심예율 케이스 핸드오프 3이슈 완료 (2026-05-30)

impact7newDSC 세션에서 심예율(`심예율_1049477532`) 조사 중 발견, impact7DB 코드/가드만 수정(데이터 미수정 — 개별 데이터는 정답과 일치). 핸드오프: `impact7newDSC/docs/handoff/2026-05-30-impact7DB-소속표시·퇴원가드·재원기간.md`.

## 이슈1 — 소속 10단지 오표시 (DB 03df0b9)
`branchFromClassNumber`(app.js)가 내신 기간 중 활성 enrollment의 `class_number`(=내신 csKey 문자열 `"2단지마포고1A"`)를 정규 반번호로 오인 → 첫 글자 `'2'`를 반번호 규칙(`'2'`=10단지)으로 해석해 2단지를 10단지로 뒤집음. **수정**: csKey 접두(`'10단지'`/`'2단지'`)를 반번호 규칙보다 **먼저** 인식. branch 필드는 정규 기준 보존, 표시만 내신 단지로 파생(설계 의도). csKey 접두는 `branchFromStudent`(1→2단지/2→10단지)가 내는 값뿐. [[project_school_by_level]] 내신키 섹션 연관.

## 이슈2 — 퇴원생 수업추가 무로그 재원 전환 가드 (DB 693c1f1)
비원생(퇴원/종강/상담, `NON_ENROLLABLE_STATUSES`)에 수업이 붙어 재원계열로 전이될 때 `change_type:'UPDATE'`만 남겨 재등원이 history에 안 잡히던 문제. **수정**: B경로(신규등록 폼 재입력)=`isReEnroll` 감지 시 `RETURN`+`STATUS_CHANGE` 명시 로그(before/after를 classifyHistory 인식 포맷 `상태:X, 반:Y`로) / D경로(saveEnrollment)·E경로(문법특강 일괄)=차단·스킵+안내(원래 rules `enrollmentStatusConsistent`가 거부하던 것 명확화). [[feedback_enrollment_status_consistency]] 유지.

## 이슈3 — 재원기간 무로그 재등원 보정 (shared v1.17.0 + DB 84cf5a3 + DSC f15ae76)
첫 출석 기산(deriveTenure v1.12.0~)은 이미 완료됐으나, 심예율은 03/13 무로그 재원 전환 때문에 `deriveTenure`가 퇴원(03/12)을 마지막으로 봐 **end=03/12 고정**(현재 재원인데 03-12~03-12 표시). **수정**: shared `deriveTenure(logs, getDate, attendances, isCurrentlyEnrolled=false)` 4번째 인자 추가(하위호환) → 현재 재원계열인데 history 마지막이 퇴원이면 `end=null`(현재 status가 진실). DB `fillTenure`=`ENROLLABLE_STATUSES.has(studentData.status)`, DSC=`isEnrollableStatus(student.status)` 전달([[feedback_db_dsc_parity]]). 심예율 재시뮬: end=null, start=03/13(첫출석)~현재 정상화. 이슈2가 앞으로의 무로그 전환을 막고, 이슈3이 기존 무로그 케이스 표시를 교정.

**검증 스크립트**(read-only): `_workspace/check-simyeyul-tenure.mjs`. 산출물 `_workspace/43`(이슈2)·`44`(DSC parity).
