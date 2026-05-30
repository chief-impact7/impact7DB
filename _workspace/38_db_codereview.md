# impact7DB 코드 리뷰 — 전역 전환 (구 school 미러 제거)

리뷰 범위: `git diff 8303854..HEAD` (커밋 4d7d50b~e2a6521)
검증: `npx vite build` 성공 / 단위 테스트(naesinHelpers·cleanup) 34건 통과 / shared v1.16.0 동치성 확인.
integration 테스트 11건 실패는 Firestore emulator 미실행(환경)으로 코드 변경과 무관.

---

## 심각도별 발견

### MINOR-1 — 로컬 라벨 동기화에 트리거 `hasAnySchool` 가드 누락 (불일치)
파일: `app.js:4896` (applyBulkPromotion), `app.js:6290` (runPromotion)

`s.school_level_grade = studentFullLabel(s)`를 **무가드**로 실행한다.
트리거 `computeLabelUpdate`(functions-shared/src/studentLabelSync.js)는
`hasAnySchool`(school_elementary/middle/high 중 하나라도 존재)일 때만 라벨을 쓰고,
하나도 없으면 `null`을 반환해 **기존값을 보존**한다.

→ 학부필드가 **전혀 없는** 학생(학교 미입력)의 경우:
- 로컬: `studentFullLabel`이 빈 학교 라벨(`"고1"`, `"중2"`)을 무조건 덮어씀
- 트리거(Firestore): 기존 `school_level_grade` 보존
두 값이 어긋난다.

영향 범위: 학교 미입력 학생에 한정(드뭄), 라벨 자체가 무의미하므로 실질 피해 작음.
검증으로 확인: 학부 전환 케이스(예 중→고, `school_middle`만 보유)는 `hasAnySchool===true`이므로
로컬·트리거 모두 `"고1"`로 **일치**한다. 따라서 본 항목은 학교 완전 미입력 학생만 해당.

수정 제안: 로컬에도 동일 가드 적용 —
`const hasAnySchool = !!(s.school_elementary||s.school_middle||s.school_high); if (hasAnySchool) s.school_level_grade = studentFullLabel(s);`
(트리거와 멱등 일치). 또는 공유 헬퍼 `computeLabelUpdate`를 클라이언트에서도 재사용.

### MINOR-2 — students 문서 필드 한도 마진 축소 (withinFieldLimit 30→35)
파일: `firestore.rules:92,98`

`school`(1개) 미러를 `school_elementary/middle/high/school_level_grade`(최대 4개)로 분리하면서
문서 키 한도를 30→35로 +5 상향. 순증 필드는 +4(학부 3 + 라벨 1, 단 동시에 구 school 1 제거 → 실 순증 +3)이므로
실질 마진은 약 +2. 모든 학부필드 + 모든 옵션필드를 가진 헤비 문서는 35에 근접할 수 있다.

영향: rules 위반으로 write 거부 가능성(낮음). 운영 중 35 초과 write 실패가 보이면 한도 재상향 필요.
수정 제안: 현재 최대 필드 보유 학생의 실제 키 수를 audit해 마진(예 40) 확보 검토. 즉시 조치는 불요.

### MINOR-3 — 검색어 정규화 방식 변경 (raw → 라벨 정규화)
파일: `school-normalizer.js:60` (schoolSearchTerms → shared studentSearchTerms 재노출)

기존 `schoolSearchTerms`는 `cleanSchoolName(s.school)` raw 기반.
신규 `studentSearchTerms`는 `normalizeSchoolForLabel`(여대→여, 지역 prefix 제거 등) 기반.
검색 키워드가 표시 라벨과 일치하도록 의도적으로 변경됨(커밋 메시지 "검색 회귀 교정").
호출처 `app.js:842,1209`는 `(s)→배열.some()` 시그니처 호환 확인.

영향: 의도된 변경. raw 학교명 전체("진명여자고등학교")로 검색하던 습관은 라벨("진명여고")로 매칭됨.
조치 불요 — 기록 목적.

---

## 정상 확인 (회귀 없음)

- **inline currentSchool 동치성** (functions/src/naesinHelpers.js:7): shared `currentSchool`과 로직 완전 동일
  (`SCHOOL_FIELD[student.level]` 폴백 `''`). level 미매핑·빈값 모두 `''` 반환으로 동치. 단위 테스트 통과.
- **트리거 미러 write 삭제** (studentLabelSync.js): school 미러 제거 후 `school_level_grade`만 동기화.
  가드·멱등성 유지. 라벨 로직 정상.
- **import toPersistFields/infoDiff** (app.js:3810,3846):
  INSERT는 `toPersistFields`로 `.school`→학부필드 변환·`.school` 키 삭제(set). UPDATE는 `_diffField`로
  해당 학부필드만 비교·merge. 입력 작업필드(`.school`)와 students 미러(school_*)를 정확히 구분.
  로컬 캐시도 변환된 `w.data` 사용 → `.school` 키 잔존 없음. 학부 미입력 시(`_diffField` 없음) school 무시 — 정상.
- **submitNewStudent school 키 제거** (app.js:2205,2267,2313): `school` 변수는 입력 검증용으로만 유지,
  studentData에는 `...schoolByLevel`로 학부필드만 저장. 미러 write 중단 정상.
- **applyBulkPromotion 라벨 시점** (app.js:4892-4896): `Object.assign(s, updateData)`(level/grade/새 학부학교)
  완료 후 `studentFullLabel(s)` 호출 → s가 최신 상태에서 라벨 계산. stale 없음.
- **runPromotion 전환 라벨** (app.js:6282-6290): `s.level=p.level` 갱신 후 라벨 계산. 전환 시 새 학부학교
  미입력이 양쪽(로컬·트리거) 동일 → `"고1"` 일치. 멱등.
- **buildLevelChangeHistory** (app.js:6236): `s.school=''` 제거, `currentSchool(s)`로 history 기록. 정상.
- **abbreviateSchool·상세·시트export·past-history·promo-extractor·naesin-schedule·consultationAiHandler**:
  모두 `s.school`→`currentSchool(s)` read 전환. 빈 학교 폴백(`|| '—'`, `|| '학교미입력'`, `|| '학교 미입력'`) 유지. UI 깨짐 없음.
- **school-normalizer schoolOf 폴백** (school-normalizer.js:5): `currentSchool(s) || s?.school || ''`.
  import temp 객체(school_* 없음, 작업용 .school 보유)도 폴백으로 처리. collectKnownSchoolNames 정상.

---

## 요약

심각도별 건수: **critical 0 / major 0 / minor 3**

- 미러 read 전환(abbreviateSchool·상세·시트·past·promo·naesin·consultationAi)·import 경로·submitNewStudent
  school 키 제거·functions inline currentSchool·트리거 미러 write 삭제는 모두 정상. 빌드·단위테스트 통과.
- MINOR-1: 학년승급 로컬 동기화가 트리거의 `hasAnySchool` 가드 없이 라벨을 덮어써, **학교 완전 미입력
  학생**에서만 로컬/Firestore 라벨이 어긋남(학부 전환 학생은 일치). 가드 추가 권장, 실질 피해는 작음.
- MINOR-2: rules 필드 한도 30→35 상향 후 실질 마진 약 +2 — 헤비 문서 write 실패 가능성 낮으나 audit 권장.
- MINOR-3: 검색어가 라벨 정규화 기반으로 바뀜(의도된 회귀 교정). 조치 불요.
- 즉시 차단 이슈 없음. MINOR-1만 오케스트레이터가 트리거-클라이언트 라벨 일관성 차원에서 수정 검토 권장.
