---
name: class-move-unification
description: 반 이동 안전화 — moveClass 공유함수 + 일괄 반 변경 학기 컨텍스트 가드 (내신 숨김/합반 누락 해소)
metadata:
  type: project
---

# 반 이동 안전화 (2026-05-29 배포 완료)

내신 복귀 학생의 정규반(HX106)이 합반(HX108)에서 누락된 사건이 발단. 근본 원인: 내신 활성 기간엔 `applyNaesinFreeDerivation`이 정규 enrollment를 숨겨(`getActiveEnrollments`), 그 학생이 반 그룹에서 "미지정"으로 빠져 일괄 선택에서 누락됨. [[feedback_naesin_blank_class_tag]]

## 핵심 메커니즘 (합반 누락의 해법)
`relevantEnrollments`(app.js:321)가 학기 필터 상태로 갈린다:
- **학기 OFF** → `getActiveEnrollments`(내신 파생, 정규 숨김)
- **학기 ON** → `enrollments.filter(semester===)` = **raw 학기 enrollment, 정규 살아있음**

→ 학기 필터만 켜면 내신 학생이 원래 반 그룹에 복원되고(반 태그·그룹·필터가 `activeClassCodes`→`relevantEnrollments` 사용), 일괄 반 변경도 그 학기 정규를 정확히 타겟팅. **합반 누락은 별도 코드 없이 "학기 ON 강제"로 해소.**

## 구현
- **`@impact7/shared/class-move`의 `moveClass(student, {semester, targetLevelSymbol, targetClassNumber})`** (v1.11.0) — 특정 학기 정규 enrollment를 in-place로 다른 반 교체하는 순수함수. `day`·`start_date`·`semester`·`naesin_class_override` 보존. 대상 없으면 `skipped`. override 없는 정규인데 반번호 끝자리 홀짝(A/B) 바뀌면 `warning`. 반환 `{updatedEnrollments, before, after, skipped, warning}`.
- **DB `applyBulkClass`(app.js:4590)** — 학기 필터 OFF면 **차단**(기존 `enrollments[0]` 무방비 폴백 제거). `moveClass` 위임 + `findEnrollmentConflicts` 충돌검사 + skipped/warning 명단 보고. 200건 청크 배치·history_logs 유지.
- 설계/계획: `docs/superpowers/specs/2026-05-29-class-move-action-design.md`, `docs/superpowers/plans/2026-05-29-class-move-semester-guard.md`.

## 후속 TODO (이번 범위 밖)
- ✅ `applyBulkDays`(app.js:4681) 학기 가드 **완료**(2026-05-29) — 일괄 등원요일 변경도 학기 OFF면 차단·`enrollments[0]` 폴백 제거·누락 보고. applyBulkClass와 동일 패턴.
- **DSC는 반 이동 미지원으로 확정** (2026-05-29 사용자 결정) — DSC에서 반 이동/일원화는 **하지 않음**. 재제안 금지.
- **수동 브라우저 검증 미완** — moveClass 단위테스트(7/7)·빌드만 통과, 실제 합반 UI 시나리오는 미검증 상태로 배포(사용자 지시). 이슈 발생 시 이 지점부터 점검.

## How to apply
반 이동(class_number 변경)은 학기 컨텍스트가 확정된 상태에서만 안전. 반 이동 로직 수정은 `@impact7/shared/class-move`(공유 SSoT)에서. [[project_naesin_free_derivation]] [[project_unique_class_code]]
