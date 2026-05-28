# DSC 구현 스펙 — 강사 배정 변경 이력 (class_teacher_history)

목적: `class_settings.teacher`는 현재값만 보존 → 강사가 바뀌면 과거가 사라짐. **지금부터** 모든 반의 강사 배정 변경을 `class_teacher_history`에 append-only로 기록해, 향후 강사 재등원율 등 분석 가능하게 함. **과거 데이터는 복구 불가(수용됨), forward-only.**

rules는 impact7db에 **이미 배포됨**(`class_teacher_history` match 블록, append-only). DSC는 이 컬렉션에 쓰기만 추가하면 된다.

## 쓰기 문서 스키마 (rules hasOnly — 정확히 이 필드만, 그 외 금지)
```
class_code      : string (required, 비어있지 않음)
class_type      : string ('정규'|'내신'|'특강'|'자유학기' 등, 모르면 '')
branch          : string (소속, 쉽게 못 구하면 '')
teacher         : string (새 담당 이메일, 미지정이면 '')
sub_teacher     : string (새 부담당, 없으면 '')
prev_teacher    : string (이전 담당, 없으면 '')
prev_sub_teacher: string (이전 부담당, 없으면 '')
changed_at      : timestamp (serverTimestamp())
changed_by      : string (현재 사용자 이메일, required 비어있지 않음 — state.currentUser?.email 등, 절대 빈 문자열 금지)
```
⚠️ **`auditAdd` 쓰지 말 것** — auditAdd는 updated_by/updated_at를 주입하는데 화이트리스트에 없어 rules가 거부함. **plain `addDoc(collection(db,'class_teacher_history'), {...})`** 사용.

## 공유 헬퍼 (신설)
`recordTeacherChange(classKey, { class_type, branch, teacher, sub_teacher, prev_teacher, prev_sub_teacher })`:
- **실제 변경 있을 때만 기록**: `teacher === prev_teacher && sub_teacher === prev_sub_teacher` 이면 그냥 return (같은 값 재저장·미변경 무시).
- changed_at=serverTimestamp(), changed_by=현재 사용자 이메일(비어있으면 기록 자체 스킵하거나 'unknown' 금지 — 가능한 한 실제 이메일).
- try/catch로 감싸 **이력 기록 실패가 강사 저장 UX를 깨지 않게**. class_settings 저장이 성공한 뒤 기록.
- 신설 모듈(예: `teacher-history.js`) 권장. state에서 필요한 것 import.

## 후킹할 3경로 (모든 반 타입 커버 — 핵심)
1. **`saveTeacherAssign(classCode)`** (class-detail.js:1171) — 정규/특강/자유학기. 드롭다운 변경. 저장 **전** `state.classSettings[classCode]`에서 prev_teacher/prev_sub_teacher 읽고, 새 select 값으로 class_settings 저장 후 recordTeacherChange 호출. class_type=state.classSettings[classCode]?.class_type.
2. **`saveNaesinClassTeacher(csKey, teacher)`** (naesin.js:1050) — **내신 (별도 경로! 빠뜨리면 내신 전체 누락)**. sub_teacher 없음(''). prev_teacher=state.classSettings[csKey]?.teacher. class_type='내신'. 저장 후 recordTeacherChange.
3. **반편성 마법사 초기 배정** (class-setup.js:1142 batchSet `{teacher}`) — 반 생성 시 첫 강사. prev_teacher=''(신규). batch commit 후, teacher가 비어있지 않은 반에 대해 recordTeacherChange (prev='' → 변경으로 간주되어 기록됨). 여러 반이면 각각.

## 제약·검증
- 기존 강사 저장(class_settings auditSet/batchSet) 동작·필드 **변경 금지**. 이력 기록은 순수 추가.
- branch는 못 구하면 ''로. class_code/changed_by만 필수.
- `npm run build` 성공 확인.
- **커밋·푸시 금지** — 보고만. (rules는 이미 배포됨)

## 보고
- 신설 파일/헬퍼, 3경로 각각 어디에 어떻게 훅했는지, prev값을 어디서 읽었는지, branch/class_type 소스, 빌드 결과.
- 보고서를 `/Users/jongsooyi/projects/impact7DB/_workspace/07_teacher_history_impl.md`에 저장.
