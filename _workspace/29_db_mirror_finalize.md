# 29. 구 `school` 미러 제거 — DB 마무리 2단계 (read 전환 + write 중단)

작성: 2026-05-30 · 상태: **구현 완료 (커밋·푸시·배포 전, 오케스트레이터 조율 대기)**
선행: 영향분석 `_workspace/22`, 블로커 ①②③(exam·내신키·newtest) 완료·배포됨.
범위: DB front(`app.js` + 모듈) + `functions-shared`. **데이터·rules 미변경.**

---

## 단계 1 — DB 남은 read 전환 (완료)

미러 `student.school` 읽기를 `currentSchool(student)`(= `student[SCHOOL_FIELD[level]]`)로 전환.

| 파일:라인 | 전환 내용 |
|----------|----------|
| `app.js` abbreviateSchool (346) | `cleanSchoolName(s.school)` → `cleanSchoolName(currentSchool(s))` |
| `app.js` 과거학생 autofill (1818) | `pastStudent.school` → `currentSchool(pastStudent)`. **부가 버그 수정:** 쓰기 타깃 `_form.school`(존재하지 않는 필드 → `undefined.value` throw, 사실상 죽은 분기)을 실제 폼 필드 `_form.school_current`로 교정 |
| `app.js` 상세 detail-school-name (1904) | `studentData.school` → `currentSchool(studentData)` |
| `app.js` 시트 export (3395·3405) | `s.school` → `currentSchool(s)` (두 행 동일) |
| `school-normalizer.js` collectKnownSchoolNames(33)·schoolSearchTerms(55) | 신규 헬퍼 `schoolOf(s)=currentSchool(s)||s.school` 경유로 변경. import temp 객체(school_* 없음)는 `.school` 폴백, 실 students는 currentSchool. `@impact7/shared/student-label` import 추가 |
| `past-history.js` (314) | `student.school` → `currentSchool(student)`. import 추가 |
| `promo-extractor.js` buildSchoolGradeStr 호출 (317) | `s.school` → `currentSchool(s)`. import 추가 |
| `functions-shared/src/consultationAiHandler.js` (33) | `student.school` → `currentSchool(student)`. functions-shared가 `@impact7/shared#v1.15.0` 의존 확인 후 `./student-label` subpath import 추가 |
| `app.js` 학년승급 oldSchool (4838) | **확인 결과 미러 폴백 잔존** → step 2에서 `|| student.school` 제거(아래) |

이미 전환된 곳(`naesin-schedule.js`, `app.js:160`·`2100`): **건드리지 않음** (확인만).

### 단계 1 게이트 — 미러 read 0 증거

`grep -rn "\.school\b"` (대상: app.js·past-history·promo-extractor·school-normalizer·naesin-schedule·functions-shared/src), 헬퍼·school_*·작업필드·쓰기키 제외 후 잔여:

```
school-normalizer.js:3   // 주석
app.js:3812              // 주석
app.js:6092              ...(_schoolField && entry.school ...)   ← import 작업필드 read(→ school_* 로 write)
```

→ **students 객체 미러 `.school` 읽기 = 0.** 잔여는 (a) 주석, (b) import staging 작업필드(`entry.school`/`raw['school']`/temp `.school`)뿐. 이들은 CSV 입력→`school_*` 저장 경로로, 미러 read 아님.
제외 도메인(건드리지 않음): `contacts.school`·`temp_attendance.school`(자체 컬렉션 require), `migrate-school-by-level.js`(dead 1회성), `import-students.js`(line 9에서 `process.exit(1)` 하드 deprecated).

---

## 단계 2 — 미러 write 중단 (게이트 통과 후 수행, 완료)

| 파일:위치 | 조치 |
|----------|------|
| `functions-shared/src/studentLabelSync.js` computeLabelUpdate | `currentSchool→school` 미러 write 라인 **삭제**, `currentSchool` import 제거. `studentFullLabel→school_level_grade` 라벨 write **유지**. 가드(`hasAnySchool`) 유지 |
| `app.js` saveStudent payload ×2 (편집·신규) | payload에서 `school,`(미러 키) **제거**. `...schoolByLevel`(school_elementary/middle/high) 유지. 검증용 `const school`(미입력 alert)는 유지 |
| `app.js` applyBulkPromotion (4833) | `updateData.school = newSchool` **삭제**(`updateData[SCHOOL_FIELD[next]]`만 유지). oldSchool 표시 `|| student.school` 폴백 제거 |
| `app.js` buildLevelChangeHistory (6216) | 반환 객체에서 `school: ''`(미러 비움) **제거**. `school_history` snapshot은 `school: currentSchool(s)`(떠나는 학부 학교)로 보존 |
| `app.js` runPromotion 로컬 sync (6267) | `s.school = ''` **제거** (school_history 로컬 반영은 유지) |
| `app.js` import runUpsertFromRows (3722 파싱·write·diff) | infoFields에서 `'school'` 제거. INSERT 시 `toPersistFields()`로 작업 `.school`→`SCHOOL_FIELD[level]` 이관 후 `school` 키 삭제. UPDATE diff는 `incoming.school`을 `ex[SCHOOL_FIELD[level]]`와 비교해 변경 시 그 학부필드에 기록(미러 우회) |
| `app.js` 문법특강 시트일괄 신규생 (6073) | `school: entry.school` → `...(SCHOOL_FIELD[entry.level] && entry.school ? { [field]: entry.school } : {})` |

**데이터 미변경:** students 15,032건 `school` 필드는 dead data로 보존(영향분석 §4). 대량 배치 미실행.
**rules 미변경:** `school` 화이트리스트 제거는 이번 미수행(허용만이라 무해). temp_attendance·contacts require 미변경.

---

## 배포 경로별 변경 분류

**A. functions-shared codebase** (`firebase deploy --only functions:shared --project impact7db`)
- `functions-shared/src/studentLabelSync.js` — 미러 write 중단 (트리거 동작 변경: 더 이상 school 미러 set 안 함)
- `functions-shared/src/consultationAiHandler.js` — read 전환 (currentSchool)

**B. DB hosting** (master push → GitHub Actions)
- `app.js` — read 전환(abbreviate/autofill/detail/export) + write 중단(saveStudent/promotion/import/grammar)
- `school-normalizer.js`, `past-history.js`, `promo-extractor.js` — read 전환

> 두 경로는 독립. 단 트리거(A)가 미러 write를 멈춘 뒤에도, 프런트(B)가 여전히 currentSchool(school_*)로 읽으므로 **배포 순서 무관**(정상학생 school_* = 기존 미러값으로 일치). leave-request codebase는 이번 변경 없음.

---

## 빌드/검증 결과

- **DB front Vite build:** ✓ 통과(`npx vite build`, 36 modules, 3.8s). help-guide.js 경고는 기존 사항(무관).
- **functions-shared 문법:** ✓ `node --check` studentLabelSync.js·consultationAiHandler.js 통과. (lint 스크립트 없음)
- **단계1 게이트:** ✓ 미러 read 0 (위 증거).
- **rules 정합:** firestore.rules students allowed에 `school_elementary/middle/high/school_level_grade` **이미 포함**(line 59-60) → saveStudent가 `school` 키 없이 school_* 만 보내도 **rules 통과**. 영향분석 §5 선결 이슈(school_* 누락)는 이미 해소된 상태로 확인.
- **currentSchool 동작:** `student[SCHOOL_FIELD[level]]` 읽기 → saveStudent가 `...schoolByLevel`로 school_* 저장하므로 표시·검색·export 값 보존.
- **simplify 적용:** import diff의 oldSchool 비교를 `currentSchool({...ex, level})` 대신 `ex[SCHOOL_FIELD[level]]` 직접 읽기로 단순화 후 재빌드 통과.

---

## 잔여 미러 의존

- **없음**(DB 도메인). 미러 `.school` read 0, write 중단 완료.
- 보존된 비활성 잔재: `migrate-school-by-level.js`(dead), `import-students.js`(deprecated exit), students 데이터 `school` 필드(dead data). 모두 무해.
- 후속(별도): rules `students` 화이트리스트에서 `school` 제거(선택, 4앱 동기화 필요) — 이번 범위 아님.

---

## 핵심 요약

1. **단계1(read 전환) 완료**: app.js 5곳(축약·autofill·상세·export·승급폴백) + school-normalizer/past-history/promo-extractor/consultationAiHandler를 `currentSchool`로 전환. autofill은 죽은 `_form.school` 타깃 버그도 교정.
2. **단계1 게이트 통과**: students 미러 `.school` 읽기 grep 결과 **0** (잔여는 주석·import 작업필드뿐).
3. **단계2(write 중단) 완료**: studentLabelSync 미러 write 삭제(라벨 write 유지), saveStudent·promotion·import·grammar payload에서 미러 `school` 제거하고 입력 학교를 `SCHOOL_FIELD[level]`에 저장하도록 전환.
4. **배포 2경로**: functions-shared(studentLabelSync·consultationAiHandler) + DB hosting(app.js 외 3모듈). 순서 무관.
5. **빌드 통과**(Vite ✓ / functions-shared 문법 ✓), rules는 school_* 이미 화이트리스트 → saveStudent 통과 논리 확인.
6. **데이터·rules 미변경**: 15,032건 dead data 보존, 대량 배치 미실행. 미러 잔여 의존 없음.
7. **커밋·푸시·배포 미실행** — 오케스트레이터 조율 대기.
