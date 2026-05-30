# 42. 내신 csKey branch 불일치 단일화 — DailyLogBoard (선재 이슈)

qa-validator 발견(`_workspace/37`): `DailyLogBoard.jsx`의 자체 `getBranch`(enrollments[0] 기준)가 정본 `branchFromStudent`(regular enrollment 기준)와 갈라져, enrollments 앞에 내신·특강이 오면 내신 csKey가 DB·DSC 정본과 불일치 → class_settings 매칭 누락 위험.

## 1. 정본 일치 선확인 (글자단위)

세 정본을 대조한 결과 `branchFromStudent` / `deriveNaesinCode`가 **글자단위 동일**:

| 항목 | DSC `student-helpers.js` | DB `functions/src/naesinHelpers.js` | 일치 |
|------|--------------------------|-------------------------------------|------|
| `branchFromStudent` | L77, `enrollments.find(정규∥자유학기).class_number` 첫자리 1→2단지/2→10단지 | L13, 동일 | ✅ |
| `deriveNaesinCode` | L112, currentSchool+LEVEL_SHORT+grade+group(끝자리 A/B·홀짝, **regular fallback**) | L34, 동일 | ✅ |
| `currentSchool` | `@impact7/shared/student-label` (raw, 정규화 없음) | inline 미러(동일 SCHOOL_FIELD) | ✅ |
| csKey 조립 | `resolveNaesinCsKey` = override∥(`branch+deriveNaesinCode`) | 동일 | ✅ |

→ DSC `deriveNaesinCode`가 csKey 생성 정본이며 `branchFromStudent`는 `resolveNaesinCsKey`에서 결합. branch 부분도 정본 일치 확인 완료.

## 2. buildNaesinKey ↔ deriveNaesinCode 출력 대조

DailyLogBoard 자체 `buildNaesinKey`(L58)와 정본 `branch+deriveNaesinCode`의 차이 2가지:

1. **branch**: OLD `getBranch`는 `enrollments[0].class_number` 기준 / 정본은 `find(정규∥자유학기)` 기준
   → enrollments[0]이 정규가 아니면(내신/특강 앞) branch 갈라짐.
2. **group guard/fallback**: OLD는 `if(!group) return ''`(group 필수, fallback 없음) / 정본 `deriveNaesinCode`는 group 못 구하면 **regular enrollment 끝자리로 재추론**, guard는 school+grade만.
   → class_number에 끝자리 숫자/AB 없는 내신 enrollment에서 OLD는 빈 키, 정본은 정상 키 생성.

school/levelShort/grade는 동일 소스라 일치.

## 3. DailyLogBoard 교체 내역 (단일 파일, +4 −34줄)

`src/dashboard/components/DailyLogBoard.jsx`:
- import 교체: `{ currentSchool }` → `{ branchFromStudent, resolveNaesinCsKey }` (정본 `../../../student-helpers.js`)
- `getBranch`(자체) **삭제** → 호출처 2곳(branch 필터, 표시 meta) `branchFromStudent`로 교체
- `buildNaesinKey`(자체) **삭제**
- `resolveNaesinKey`를 정본 wrapper로 축소: `resolveNaesinCsKey(student, enrollment) || ''`
  - override 처리·자동유도·group fallback 모두 정본 위임. 정본 null 반환을 `|| ''`로 정규화해 기존 호출처 falsy 가드(`key ? classSettings[key] : null`, L302 `|| '내신'`)와 동작 동일.
  - 호출처 3곳 모두 두번째 인자로 **정규 enrollment**(`regularEnrollment(...)`) 전달 → 정본 시그니처 `resolveNaesinCsKey(student, regularEnroll)`와 정확히 일치.

state.js/student-helpers.js는 브라우저 전역 의존 없는 순수 ES 모듈 → dashboard 번들 안전(빌드 시 `student-helpers-*.js` 청크 분리 확인).

## 4. csKey 일치 검증 (표본)

단일화 전후 비교 스크립트(`/tmp/verify_csKey.mjs`) 실행 결과:

| 케이스 | 정본 csKey | OLD | 교체후 |
|--------|-----------|-----|--------|
| 정상-정규첫번째 | 2단지서초고고1A | 동일 | == 정본 ✅ |
| **일탈-내신앞정규뒤** | 10단지서초고고1A | 서초고고1A (branch누락) | == 정본 ✅ |
| **일탈-특강앞정규뒤** | 2단지운중중2B | 10단지운중중2A (branch+group 둘다 틀림) | == 정본 ✅ |
| branch미설정+정규반 | 10단지세화고고2B | 동일 | == 정본 ✅ |
| 자유학기 | 2단지언북중중1A | 동일 | == 정본 ✅ |
| branch명시 | 10단지영동고고3A | 동일 | == 정본 ✅ |
| **group끝자리없음-fallback** | 2단지대청중중3A | "" (빈키) | == 정본 ✅ |

- **정상(원래 같던) 학생 diff 0** 확인.
- **일탈 3건 교정**: enrollments[0] 비정규 케이스에서 branch 누락/오판 + group fallback 누락이 모두 정본으로 정정. 특히 "특강앞정규뒤"는 `10단지운중중2A`→`2단지운중중2B`로 키 전체가 달라지던 위험 케이스.

## 5. 빌드·테스트

- `npm run build`: ✓ built in 13.41s (dashboard 607kB, student-helpers 청크 분리 정상)
- `npm run test`: 19/19 pass

## 제약 준수
- 커밋·푸시·배포 안 함. 정본(student-helpers/naesinHelpers) 미수정 — DailyLogBoard만 정본에 맞춤.
