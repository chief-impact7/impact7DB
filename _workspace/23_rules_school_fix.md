# 23. firestore.rules — 학부별 학교 필드 화이트리스트 버그 수정

전역 전환 후속 1번의 선결 작업. **rules 파일 수정까지만 완료.** `firebase deploy`·4앱 동기화는 미실행(오케스트레이터 승인 후 조율 대상).

## 1. 버그 실증

### 1-1. client write payload (app.js saveStudent)
`saveStudent`가 students에 보내는 키(merge 기준):

- 항상: `name, level, school, grade, student_phone, parent_phone_1, parent_phone_2, branch, status, enrollments`
- **학부별 학교(누락 필드)**: `...schoolByLevel` = `school_elementary, school_middle, school_high` (line 2267 edit / 2314 create). 폼의 3칸을 항상 전송(빈값이면 ''), `school`(현재 학부 미러)도 함께 전송.
- 휴원 시: `pause_start_date, pause_end_date`
- studentNumber 미보유 시 발급: `studentNumber, studentNumberSource, studentNumberIssuedAt`
- status 변경 시: `status_changed_at, status_changed_by, status_previous`
- edit 시 레거시 flat 필드는 `deleteField()`로 제거: `day, class_type, level_code, level_symbol, class_number, start_date, special_start_date, special_end_date`

### 1-2. 트리거 (functions-shared `onStudentLabelSync`)
`students/{docId}` onDocumentWritten → `computeLabelUpdate(after.data())`가 admin SDK `after.ref.update()`로 `school`(미러) + `school_level_grade`를 set. **별도 트리거 write**이므로 client write의 `request.resource.data`에는 직접 포함되지 않지만, 결과 문서에 영구 저장되어 이후 client **update의 merge 결과 문서에는 남는다.**

### 1-3. rules 위반 지점
`hasOnlyAllowedStudentFields()`의 allowed(line 58~74)에 `school_elementary` / `school_middle` / `school_high` / `school_level_grade`가 **부재** → `request.resource.data.keys().hasOnly(allowed)` 위반. git 이력상 이 4개 필드는 rules에 한 번도 추가된 적 없음 → 배포본에도 없음.

**결론(가설 확정): 학부별 학교를 입력하거나, 이미 `school_*`/`school_level_grade`를 보유한 학생을 폼에서 저장하면 `hasOnly` 위반으로 rules-reject. Phase 1 학부별 학교 입력 UI가 실제로 막혀 있었음.**

### 1-4. 실측 (admin SDK, service-account.json 재사용 / 전수 15,675건)
- 키수 분포: `19`키가 14,667건(주류). 최대 `26`키 1건(`고태원_1091516455`).
- `school_level_grade` 보유: 15,365건. `school_elementary/middle/high` 중 하나 이상 보유: 15,365건 → **이미 거의 전수가 트리거 필드를 보유** → 사실상 모든 학생 저장이 reject 위험.
- `school_middle` 9,445 / `school_elementary` 2,965 / `school_high` 2,955건.
- allowed 밖 필드 `enrollments_cleared_at/by`(264건, leave-request admin이 씀)가 별도로 존재 — **선재 버그**(이 작업 범위 아님, 아래 영향 참조).

### 1-5. withinFieldLimit(30) 판정
client edit-update의 merge 결과 문서 키수를 전수 시뮬레이션:
- **hasOnly를 통과하는(allowed 밖 키 없는) 문서 기준 worst-case = 27키** (`채현우_1089108223`: school 3종 + school_level_grade + pause_* + status2 + studentNumber 3종 모두 보유).
- 여기에 동일 저장에서 status 변경이 동반되면 `status_changed_*` 3개 추가 → **최대 30키**. 현재 한도 30이면 `<= 30` 경계라 여유 0.
- 전체 union worst는 28(고태원, `enrollments_cleared_*` 2개 포함)이나 그 2개는 allowed 밖이라 hasOnly에서 먼저 차단 → limit 판정 대상 아님.

→ **30 한도는 school_* 추가 후 worst-case(30)와 동률로 여유가 없어 상향 필요.**

## 2. 적용한 rules 수정 (firestore.rules, students 블록만)

### 2-1. allowed 배열에 4개 필드 추가 (line 59)
```
'name', 'level', 'school', 'grade',
'school_elementary', 'school_middle', 'school_high', 'school_level_grade',   // ← 추가
'student_phone', ...
```

### 2-2. withinFieldLimit 30 → 35 (create line 90 / update line 96)
- 근거: hasOnly 통과 실측 worst 27 + status 변경 동반 메타 3 = **30**(실제 발생 가능 최대) + 향후 필드 증가 여유 5 = **35**. 과도 상향(50+) 회피.

### 2-3. 미변경(범위 밖)
- `temp_attendance`(line 553~)·`contacts`(line 616~)의 `school` require/allowed: **건드리지 않음.**
- 다른 컬렉션 한도·화이트리스트: 미변경.

## 3. 검증
- `firebase deploy --only firestore:rules --dry-run --project impact7db` → **`rules file firestore.rules compiled successfully` / `Dry run complete!`** (실제 배포 안 함).
- 논리 검증: 수정 후 allowed가 `school_*` 4종 포함 → hasOnly 통과. limit 35 ≥ worst-case 30 → withinFieldLimit 통과. saveStudent payload가 allowed·limit 모두 통과 확인.

## 4. 배포 시 영향 — 4앱 동기화 필요 여부
- **동기화 필요: YES.** students 블록은 DB/DSC가 공유하는 마스터 컬렉션. firestore.rules는 DB/DSC/HR/exam 4개 프로젝트가 동일 파일을 보유(동기화 대상). 배포는 오케스트레이터가 `firestore-rules-sync` 스킬로 4앱에 복사 후 각 프로젝트에서 배포 조율.
- 본 작업은 **DB 리포의 firestore.rules 파일만 수정.** 커밋·푸시·`firebase deploy`·동기화 미실행.
- 별건(범위 밖) 관찰: `enrollments_cleared_at/by`(264건)가 allowed에 없어, 해당 문서를 폼에서 update하면 여전히 hasOnly로 reject됨. 이번 수정과 무관한 선재 버그 — 별도 판단 필요.

---
### 핵심 요약
1. **버그 확정**: saveStudent가 `school_elementary/middle/high`를 client write하고 트리거가 `school_level_grade`를 admin set하는데, rules allowed에 이 4개가 없어 `hasOnly` 위반 → 학생 저장 rules-reject. 실측상 15,365/15,675건이 트리거 필드 보유 → 사실상 전수 영향.
2. **limit 실측**: hasOnly 통과 worst 27키, status 변경 동반 시 최대 30키 → 현재 한도 30은 여유 0.
3. **수정**: allowed에 `school_elementary/middle/high/school_level_grade` 추가 + `withinFieldLimit` 30→35(worst 30 + 여유 5). students 블록만, temp_attendance·contacts·타 컬렉션 미변경.
4. **검증**: `--dry-run` 컴파일 성공.
5. **배포 영향**: 4앱(DB/DSC/HR/exam) firestore.rules 동기화 필요 — 오케스트레이터 승인·조율 대상. 본 작업은 파일 수정만, 배포·커밋·동기화 미실행.
6. **별건**: `enrollments_cleared_at/by`(264건, admin 작성)가 allowed 밖 — update 시 hasOnly reject되는 선재 버그(이번 범위 아님).
