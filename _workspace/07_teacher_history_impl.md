# 구현 보고 — 강사 배정 변경 이력 (class_teacher_history)

대상: impact7newDSC. forward-only append. rules는 impact7db에 이미 배포됨(DSC firestore.rules에도 동기화 반영되어 있음).
커밋·푸시 안 함(보고만). 빌드 성공.

## 1. 신설 파일 / 헬퍼

**`/Users/jongsooyi/projects/impact7newDSC/teacher-history.js` (신설)**

`export async function recordTeacherChange(classKey, { class_type, branch, teacher, sub_teacher, prev_teacher, prev_sub_teacher })`

- plain `addDoc(collection(db, 'class_teacher_history'), {...})` 사용. **auditAdd 미사용**(updated_by/updated_at 주입 시 rules hasOnly 위반).
- 기록 문서는 rules가 요구하는 정확히 9개 필드만:
  `class_code(=classKey), class_type, branch, teacher, sub_teacher, prev_teacher, prev_sub_teacher, changed_at(serverTimestamp()), changed_by`.
- **미변경 스킵**: `teacher === prev_teacher && sub_teacher === prev_sub_teacher` 이면 return (같은 값 재저장 무시).
- **changed_by 보장**: `auth.currentUser?.email || state.currentUser?.email || window._auditUser`. 비어 있으면 기록 자체를 스킵('unknown' 안 씀) → rules의 `changed_by.size() > 0` 위반 방지.
- **try/catch로 감쌈**: 이력 기록 실패가 강사 저장 UX를 깨지 않음(console.warn만).
- **READ_ONLY 가드**: audit.js의 `READ_ONLY`를 import해서 dev READ-ONLY 모드에선 console.log stub만(프로덕션 직격 dev 환경에서 실수 쓰기 방지). audit.js의 `_stub` 패턴과 일관.

## 2. 3경로 훅 (모든 반 타입 커버)

각 경로 공통 패턴: **class_settings 저장 호출 직전에 prev값을 state에서 읽고**, **저장 성공 후** `await recordTeacherChange(...)`. 호출은 기존 저장 try 블록 안에 두지만 헬퍼가 내부에서 실패를 흡수하므로 저장 UX 영향 없음.

### 경로 1 — 정규/특강/자유학기: `saveTeacherAssign(classCode)`
- 파일: `class-detail.js` (함수 시작 1171행 부근)
- prev 읽기: `const prev = state.classSettings[classCode] || {}` → `prev.teacher || ''`, `prev.sub_teacher || ''`
- 저장: 기존 `saveClassSettings(classCode, { teacher, sub_teacher })` 그대로(변경 없음).
- 저장 후: `recordTeacherChange(classCode, { class_type: prev.class_type||'', branch: prev.branch||'', teacher, sub_teacher: subTeacher, prev_teacher, prev_sub_teacher })`
- import 추가: `import { recordTeacherChange } from './teacher-history.js';`

### 경로 2 — 내신(별도 경로): `window.saveNaesinClassTeacher(csKey, teacher)`
- 파일: `naesin.js` (1050행 부근)
- prev 읽기: 저장 전에 `const { classSettings } = _state();` 끌어올려 `classSettings[csKey]?.teacher || ''`(prev_teacher), `classSettings[csKey]?.branch || ''`(branch).
- 저장: 기존 `auditSet(doc(db,'class_settings',csKey), { teacher }, { merge:true })` 그대로(변경 없음).
- 저장 후: `recordTeacherChange(csKey, { class_type: '내신', branch, teacher, sub_teacher: '', prev_teacher, prev_sub_teacher: '' })`. **내신은 sub_teacher 없음 → ''.**
- import 추가: `import { recordTeacherChange } from './teacher-history.js';`

### 경로 3 — 반편성 마법사 초기 배정: `submitWizard()`
- 파일: `class-setup.js` — `await batch.commit();` (1266행 부근) **직후**, success toast 전.
- batchSet(class_settings, { teacher })는 그대로(변경 없음). commit 성공이 곧 class_settings 저장 성공.
- `if (d.teacher) { recordTeacherChange(d.classCode, { class_type: d.classType||'', branch: d.classType==='내신' ? (d.naesinBranch||'') : '', teacher: d.teacher, sub_teacher: '', prev_teacher: '', prev_sub_teacher: '' }) }`
- **prev_teacher='' (신규)** → 미변경 스킵 로직상 teacher가 있으면 변경으로 간주되어 기록됨. teacher 비어 있으면 호출 자체 생략(불필요 빈 기록 방지, 헬퍼도 동일 스킵).
- import 추가: `import { recordTeacherChange } from './teacher-history.js';`

## 3. prev값을 읽은 곳

| 경로 | prev_teacher | prev_sub_teacher | 비고 |
|------|--------------|------------------|------|
| 경로1 saveTeacherAssign | `state.classSettings[classCode].teacher` | `state.classSettings[classCode].sub_teacher` | 저장 전 스냅샷 |
| 경로2 saveNaesinClassTeacher | `classSettings[csKey].teacher` (`_state()`) | 항상 '' (내신 sub 없음) | 저장 전 스냅샷 |
| 경로3 submitWizard | 항상 '' (신규) | 항상 '' | 스펙대로 신규 취급 |

## 4. class_type / branch 소스

- **class_type**:
  - 경로1: `state.classSettings[classCode].class_type`(정규/특강/자유학기 — 모르면 '')
  - 경로2: 고정 `'내신'`
  - 경로3: `wizardData.classType`
- **branch**: 모든 경로에서 사실상 `''`.
  - 확인 결과 `class_settings` 문서에는 **branch 필드가 직접 저장되지 않음**(saveClassSettings/batchSet 어디서도 branch를 안 씀). 따라서 `prev.branch`는 항상 undefined → `|| ''`.
  - 내신 csKey는 branch 접두사를 포함하지만(`2단지신목중2A`) branch 목록 없이 안전 분리 불가. 마법사 내신만 `wizardData.naesinBranch`가 있으면 채움(있을 때).
  - 스펙의 "branch는 쉽게 못 구하면 ''" 조항에 부합.

## 5. 제약 준수 / 빌드

- 기존 강사 저장(class_settings auditSet/batchSet)의 동작·필드 **변경 없음** — 순수 추가(저장 후 별도 컬렉션 append).
- `students` 컬렉션 쓰기 없음.
- rules 9개 필드 == 헬퍼 9개 필드 정확히 일치 확인(DSC firestore.rules:372 블록과 대조). `class_code`/`changed_by` non-empty 보장.
- 빌드: `npm run build` **성공** (vite 7.3.1, 746 modules, `teacher-history-*.js` 청크 정상 생성, 에러 0).

## 변경 파일 목록
- 신설: `/Users/jongsooyi/projects/impact7newDSC/teacher-history.js`
- 수정: `/Users/jongsooyi/projects/impact7newDSC/class-detail.js` (import + saveTeacherAssign)
- 수정: `/Users/jongsooyi/projects/impact7newDSC/naesin.js` (import + saveNaesinClassTeacher)
- 수정: `/Users/jongsooyi/projects/impact7newDSC/class-setup.js` (import + submitWizard batch.commit 후)
- (참고) `firestore.rules`는 내가 수정하지 않음 — impact7db에서 동기화된 class_teacher_history 블록이 dirty로 존재.

## 미커밋 상태
요청대로 커밋·푸시 안 함. simplify 패스 수행했으나 신규 코드가 이미 로컬 패턴을 따르고 간결하여 추가 변경 없음.
