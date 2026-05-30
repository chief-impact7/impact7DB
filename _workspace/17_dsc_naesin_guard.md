# 17. DSC 반편성 마법사 — 내신 기간 중 정규 추가 override 가드

## 배경 / 근본원인
- 내신은 전원 `정규 enrollment + naesin_class_override`로 파생 표시(명시 `class_type='내신'` enrollment 폐기, 통일 완료).
- 내신 기간 중인 학생을 반편성 마법사 **정규 모드**로 추가하면 override 없는 정규가 생겨 내신이 안 잡힘 (김시헌 케이스 — silvia가 내신 기간 중 정규 HS201을 override 없이 추가).
- DSC 가드로 silvia 같은 주 재발 경로를 차단.

## 가드 추가 위치
- 파일: `/Users/jongsooyi/projects/impact7newDSC/class-setup.js`
- 함수: `window.submitWizard`
- 삽입 지점: 학생 enrollments 병렬 로드(`enrollmentsByDocId` 채움) **직후**, batch 빌드/학생 loop **이전**.
  - 이유: 자유학기 판정에 기존 정규 enrollment가 필요하고, commit 전이라 취소 시 부작용 없음.
- import 추가:
  - `import { LEAVE_STATUSES, LEVEL_SHORT, state } from './state.js';` (state 추가)
  - `import { buildNaesinCsKey, resolveNaesinCsKey } from './student-helpers.js';` (resolveNaesinCsKey 추가)

## 동작 조건
- `d.classType === '정규' || d.classType === '자유학기'` 일 때만 동작.
- 내신 모드(`classType === '내신'`, override를 박는 정상 경로)는 가드 대상 아님 — 지시대로 제외.
- 재원생만 검사(`isEnrollableStatus(student.status)` 통과한 학생만).

학생별 판정:
1. **probe enrollment**(override 없는 정규)를 만들어 csKey 유도.
   - 정규 모드: `{ class_type:'정규', level_symbol:d.levelSymbol, class_number:d.classNumber }` (이번에 추가될 새 정규).
   - 자유학기 모드: 기존 정규/자유학기 enrollment 중 코드가 `d.classCode`와 일치하는 것을 probe로 사용. 이미 `naesin_class_override`(string)가 박힌 경우는 정상 경로라 **continue**(가드 제외).
2. `resolveNaesinCsKey(student, probe)` 호출 → override 없으니 폴백으로 `deriveNaesinCode`(학교+과정+학년 + 정규 반번호 끝자리 A/B) + `branchFromStudent`로 csKey 유도. `null`이면 내신 대상 아님 → skip.
3. **class_settings 조회**: class-setup 진입점은 `state.classSettings`를 채우지 않으므로, 유도된 csKey가 캐시에 없으면 `getDoc(doc(db,'class_settings',csKey))`로 읽어 `state.classSettings[csKey]`에 주입(존재 안 하면 `{}`). 이후 같은 csKey 재조회 방지.
4. **활성 내신기간 판정**: `cs.naesin_start ≤ today ≤ cs.naesin_end` 이면 "내신 기간 중" 학생으로 수집.

## 띄우는 confirm
대상 학생이 1명 이상이면:
```
다음 학생은 현재 내신 기간입니다: {이름들}. 정규로만 추가하면 내신이 안 잡힙니다. 내신 반편성 마법사로 배정하세요.
그래도 계속하시겠습니까?
```
- 취소 → 중단(버튼 disabled 해제 + `<span class="material-symbols-outlined">check</span> 반 생성` 복원, 기존 finally/취소 패턴과 동일), commit 안 함.
- 확인 → 운영자 판단으로 그대로 진행(기존 흐름 그대로).

## deriveNaesinCode / resolveNaesinCsKey 활용 방식
- `resolveNaesinCsKey(student, regularEnroll)` (`student-helpers.js`):
  - `naesin_class_override`가 string이면 그 값(또는 `''`=배제→null) 사용.
  - override가 없으면(undefined) → `deriveNaesinCode(student, regularEnroll)` 폴백 + `branchFromStudent(student)` 접두 → csKey.
- 가드는 **override 없는 정규**를 probe로 넘기므로 항상 폴백(deriveNaesinCode) 경로를 타 학교+학년 기반 csKey를 유도 → 그 csKey의 내신기간으로 판정. 이게 "override 없으면 내신이 어디로 잡혔어야 했는지"를 정확히 재현.
- A/B 판별은 `deriveNaesinCode`가 정규 class_number 끝자리(홀수=A/짝수=B)로 처리. 정규 모드 probe의 class_number(=`d.classNumber`)가 사용됨.

## 제약 준수
- 기존 마법사 동작 변경 최소화 — 가드 블록만 추가, 기존 loop/batch/로그 로직 무수정.
- class_settings는 `state.classSettings` 사용(비어 있으면 필요한 csKey만 lazy 주입).
- 내신 모드 경로 무변경.

## 빌드 결과
- `npm run build` **성공** (vite v7.3.1, 747 modules, built in ~5.7s).
- 신규 에러/경고 없음. 출력의 chunk-size 경고는 기존부터 있던 것(classSetup 312KB 등).

## 커밋/푸시
- **미수행** (지시대로 보고만). 변경 파일: `/Users/jongsooyi/projects/impact7newDSC/class-setup.js`.

## 비고 — DB 파리티
- DB에도 정규 추가 시 동일 취지 가드가 파리티상 필요하나, DB는 `deriveNaesinCode`가 없어 구현 방식이 다름 → **이번 범위 밖**(별도 처리). DSC 가드가 silvia 주 재발 경로를 차단.
