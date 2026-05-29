---
name: naesin-free-derivation
description: 내신/자유학기 표시·수업이력을 override 기반 파생으로 DB·DSC 통일 (공유모듈 SSoT) + 91명 데이터 정리 완료
metadata:
  type: project
---

# 내신/자유학기 파생 통일 (2026-05-29 완료)

DB가 명시적 `class_type:'내신'` enrollment만 인식해, 마법사 표준(정규+`naesin_class_override`) 학생이 **DB=정규 / DSC=내신**으로 갈리던 문제를 해소.

**SSoT:** `@impact7/shared/enrollment-derivation` — DB·DSC가 공유. 내신/자유학기 표시·이력 로직 수정은 **이 모듈에서만**.
- `applyNaesinFreeDerivation(current, {classSettings, dateStr, resolveNaesinCsKey, enrollmentCode})` (v1.7.0) — 현재 표시용. 정규+override+class_settings 활성 내신/자유학기 기간 → 내신/자유학기로 치환(정규 숨김). 명시적 내신/자유학기 우선.
- `deriveClassPeriodHistory(enrollments, classSettings, {enrollmentCode})` (v1.8.0) — 수업이력용. override 기반 내신/자유학기를 "수업추가" 항목으로 합성(로그 없는 케이스). 명시적 enrollment 있으면 파생 안 함(중복 방지).

**적용:**
- DB `getActiveEnrollments`(app.js)가 `applyNaesinFreeDerivation` 호출. **class_settings를 loadStudentList에서 eager-load**(`loadClassSettings`, 첫 렌더 전 필수 — 미로드 시 파생 안 됨). resolveNaesinCsKey는 **override-only**(DB는 자동유도 없음).
- DSC `getActiveEnrollments`(student-helpers.js) — 기존 inline 파생을 공유 함수로 교체(동작 보존, differential 14/14).
- 수업이력: DB `renderHistory`, DSC `class-history.js`가 `deriveClassPeriodHistory`로 파생 항목 합성 + 로그 code dedup + 시간 역순 병합.

**데이터 정리 (마이그레이션):** 91명(배보음형 — 정규+override에 더해 잉여 **키 없는** 명시적 내신 enrollment 보유)의 명시적 내신 enrollment **142개 제거 → override-only 통일**. admin SDK 배치, updated_by='naesin-cleanup'. 백업: `_workspace/14_naesin_cleanup_backup.json`(로컬, PII라 미커밋).
- **예외 1명: 김시헌**(override 없어 명시적 내신만 → 제거 시 내신 소실되므로 explicit 유지). override 없는 explicit 내신 학생은 이 패턴.

**How to apply:** 마법사 내신/자유학기는 정규 enrollment에 override만 박음(명시적 내신 안 만듦)이 표준. 표시/이력이 DB·DSC 다르면 enrollment-derivation 공유모듈 확인. [[feedback_db_dsc_parity]]

## override 누락 가드 (2026-05-29, DSC 반편성 마법사)
내신 기간 중 학생을 **정규/자유학기 모드로 추가**하면 override 없는 정규가 생겨 내신이 안 잡힘(김시헌 사고). DSC `class-setup.js` `submitWizard`에 가드 추가(commit 961ce58): `resolveNaesinCsKey`로 csKey 유도 → `class_settings` 활성 내신기간이면 confirm 경고 → 내신 마법사 유도.
- **DSC-only가 의도된 설계(파리티 위반 아님).** 내신 override 배정은 DSC 반편성 마법사에서만 일어남. DB 등록 시엔 override를 안 박으므로(나중에 DSC에서 설정) DB에 같은 가드를 넣으면 모든 신규 등록이 오경고. 즉 경로 특화 가드라 DB 대응 불필요.

## 재원기간(tenure) 표시 (2026-05-29 추가)
**규칙(사용자 정의):** 재원기간 = 등록(신규)/재등원부터 → 퇴원/종강이 끝. **휴원/복귀는 기간을 끊지 않음.** 퇴원 후 재등원은 새 기간.
- **enrollment의 start_date는 재원기간이 아님** — start_date는 반별 인스턴스 시작일이고 복귀 때마다 복귀일로 리셋됨(promote/출결용). 재원기간과 혼동 금지.
- 파생: `@impact7/shared/history`의 **`deriveTenure(logs, getDate)`** (v1.9.0) → history_logs에서 {start,end}. 신규/재등원=시작, 퇴원=끝, 휴원/복귀 무시. 종강은 classifier 미분류라 앱이 status='종강'+status_changed_at으로 end 보완.
- DB(app.js `fillTenure`/`formatTenure`)·DSC(student-detail.js 동명) 수업정보 카드에 표시, 비동기 조회+stale 가드. END=퇴원일/종강일/"현재".

## 재원기간 vs 레벨기간 — 용어 분리 (2026-05-29)
혼동 방지를 위해 두 기간 개념을 용어로 분리. 둘 다 공유모듈에서 가져옴(DB·DSC 동일 값).
- **재원기간** = 이력 기반 `deriveTenure`(등록~현재/퇴원). 위치: DB 수업정보 카드 / **DSC 헤더**.
- **레벨기간** = 현재 반 시작일(`enrollment.start_date` 최소 유효일)+경과. `@impact7/shared/enrollment-derivation`의 **`deriveLevelPeriod(enrollments, todayStr)`** (v1.10.0) → `{start, label}`(label: '14일'/'3개월'/'1년 2개월'/'등원예정'). 위치: DB '수강 현황' 카드(구 '재원 현황') / **DSC 등원 일정 카드**(레벨 태그 prefix).
- **DSC 레이아웃 분기(의도)**: DSC 헤더는 레벨 이력 행 제거·재원기간만, 등원 일정에 레벨기간. DB는 수강 현황 카드에 레벨기간+레벨 이력 유지. 파리티는 값/로직(공유모듈)이지 픽셀 배치가 아님.
- **내신 학생 리스트 카드 부제목**: 내신반명 하나로 축약(', 내신'은 배지 중복, 학교라벨은 반명에 포함). `daily-ops.js` renderListPanel. 정규 학생은 `studentShortLabel`(학교) 유지.
