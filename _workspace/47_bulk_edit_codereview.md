# 일괄수정 개선 코드리뷰 — 반 이동 + 학교이름 변경

대상: `app.js`(`applyBulkClass` 수정, `applyBulkSchool`/`resetBulkSchool` 신규, `resetBulkClass` 수정), `index.html`(카드 2개). 미커밋 diff.
설계: `docs/superpowers/specs/2026-05-31-bulk-edit-classmove-school-design.md`
리뷰일: 2026-05-31 · **발견·기록만, 코드 수정 없음**

---

## 결론 요약

설계 의도(없는 반 가드, 시작일 후처리, 학교이름 일괄, simplify 압축)는 대체로 정확히 구현됐다. **critical 없음.** major 2건은 가드의 정합성 빈틈(원자성·casing), minor는 UX/문구. 핵심은 아래 #1 (없는 반 가드가 "정상 이동"도 막을 수 있는 케이스)와 #2 (학교 변경의 stale-label 위험)다.

---

## 발견

### [MAJOR] M1 — 없는 반 가드: 정상 이동인데 차단되는 경계 케이스
`app.js:4688-4701`

가드 집합 `regularCodes`는 **활성 학생 전원의 현재 학기 정규 enrollment 반코드**로 만든다. 그런데 입력 `raw`가 "대상 반에 이미 다른 학생이 있는가"를 묻는 게 아니라 "활성 학생 중 누구든 그 코드를 가졌는가"를 묻는다. 두 시나리오가 모두 통과/차단되어야 정확한데, 경계에서 어긋난다:

- **시나리오 A (설계가 막으려는 것):** 선택 학생 전원을 빈 신설 반(기존 0명)으로 첫 이동 → 집합에 `raw` 없음 → 차단. **정상 동작.** OK.
- **시나리오 B (오탐 위험):** 대상 반에 "현재" 학생이 있긴 하나 그 학생이 **선택 대상에 포함**돼 같은 반으로 재이동하는 경우 등은 통과(OK). 하지만 **대상 반의 유일한 점유자가 비활성(퇴원/상담/종강) 학생**이면 — 즉 반 자체는 실재하나 활성자가 0명이면 — 집합에 안 들어가 **존재하는 반인데 차단**된다. 설계 §22의 "활성 학생 해당 학기 정규" 정의를 그대로 따른 결과이므로 사양상 의도일 수 있으나, 운영상 "방금 다 퇴원한 반으로 재배치"가 막히는 건 의외일 수 있음.

판정: 설계 명세(활성 기준)와 코드는 일치. **버그라기보다 사양의 의도 확인 필요.** 만약 "실재하는 반(활성 무관)"으로 막고 싶었다면 `ENROLLABLE_STATUSES` 필터를 빼야 한다. 현 상태로 둘 거면 의도임을 메모 권장.

수정안(선택): 가드 목적이 "오타·신설 방지"뿐이면 활성 필터 제거가 오탐을 줄인다. 현 사양 유지 시 수정 불요.

---

### [MAJOR] M2 — 없는 반 가드 + moveClass의 level_symbol 대소문자
`app.js:4690-4694`, `enrollmentCode`(app.js:196), 저장부(app.js:3061, 2331)

`raw`는 `.toUpperCase()`된 값(4673). 가드 집합은 `enrollmentCode(e)` = `level_symbol + class_number`를 **대소문자 정규화 없이** 넣는다(196). 그런데 `level_symbol`은 입력 저장 시 `.trim()`만 하고 **대문자화하지 않는다**(3061·2331 모두 uppercase 없음; placeholder만 "HA"). 따라서 기존 데이터에 소문자/혼합 심볼(`ha101`)이 있으면:

- 집합엔 `ha101`이 들어가고, `raw`는 `HA101` → `regularCodes.has('HA101')` **false → 존재하는 반인데 "존재하지 않는 반" 오탐 차단.**

실데이터가 전부 대문자면 무해(기존 `applyBulkClass`/`moveClass`도 대문자 가정으로 동작해 왔음 — pre-existing 가정). 하지만 이 가드가 **새로 대소문자 민감 비교를 도입**하므로, 데이터에 소문자가 1건이라도 있으면 그 반으로의 모든 일괄 이동이 차단된다. 회귀 위험.

수정안: 집합 적재 시 `enrollmentCode(e).toUpperCase()`로 정규화하여 `raw`와 같은 기준으로 비교. (또는 저장 경로에서 `level_symbol` 대문자화를 강제 — 범위 밖.)

---

### [MAJOR] M3 — applyBulkSchool: school_level_grade 로컬 갱신과 Firestore의 불일치 가능성
`app.js:5010-5017`

Firestore에는 `{ [field]: schoolName }`만 쓰고 `school_level_grade`는 **트리거(`onStudentWrite` → `computeLabelUpdate`)에 위임**한다. 로컬은 `studentFullLabel(s)`로 즉시 갱신. 두 라벨 계산이 **동일 함수**(shared `studentFullLabel`)라 보통 일치한다. 단:

- 로컬 `s`에는 `school_level_grade`만 갱신하고 `field`도 갱신했으므로 입력은 동일 → 라벨 동일. **정합 OK.**
- 가드 `if (s.school_elementary || s.school_middle || s.school_high)`는 트리거의 `hasAnySchool`(studentLabelSync.js:7)과 **동일 의미**. OK. 단 방금 `s[field]=schoolName`을 했으므로 이 가드는 사실상 항상 true(빈 학교명은 상위에서 이미 차단). 무해하나 중복.

판정: **버그 아님**, 정합 일치 확인됨. 다만 트리거가 어떤 이유로 미발화/지연되면 Firestore의 `school_level_grade`가 잠시 stale일 수 있으나, 이는 학년승급(`applyBulkPromotion`)과 동일한 기존 패턴이므로 수용. **기록만.**

---

### [MINOR] m4 — 시작일 후처리 mIdx와 moveClass idx의 일치
`app.js:4727-4730` vs `class-move.js:13`

`moveClass`는 `findIndex(isRegular && semester===semester)`로 첫 정규 enrollment를 이동(idx). 후처리 `mIdx`도 **동일 술어**(`(class_type||'정규')==='정규' && semester===sem`)로 `findIndex` → 같은 enrollment를 가리킨다. 학생당 같은 학기 정규가 1개라는 도메인 전제 하에 **정확히 동일 인덱스**. start_date만 덮어쓰고 나머지 보존(`{...e, start_date}`). **정합 OK.**

엣지: `bulk-class-startdate`가 `type=date`라 값은 `''` 또는 `YYYY-MM-DD`. 빈값이면 `startDate=''` falsy → 후처리 스킵, moveClass의 start_date 보존(설계 §23 일치). 형식 오류 입력 불가(브라우저 date input). **OK.**

---

### [MINOR] m5 — applyBulkSchool: confirm/alert 문구의 학부 표기
`app.js:4998`, `5009`, `5014`

`level` 값이 `초등|중등|고등`이라 `${level} 학교`는 "초등 학교"/"중등 학교"로 렌더(어색한 띄어쓰기). history `before/after`도 `중등학교: …`. 동작엔 영향 없음. 표시 다듬으려면 `levelShortName(level)`(이미 import됨, school-normalizer) 활용 가능.

---

### [MINOR] m6 — confirm 모수: selectedStudentIds.size vs changes.length
`app.js:4705`(class), `5009`(school)

두 confirm 모두 `selectedStudentIds.size`로 안내하나 실제 변경은 `changes.length`(존재하지 않는 id 제외분). school은 `changes.length===0` 가드가 있어 0건은 막지만, "N명 설정" 안내 후 실제 일부만 반영될 수 있음. class는 confirm이 moveClass/skip 계산 **전**이라 "N명 이동" 후 skip으로 적게 반영 — 기존 코드도 동일했고 완료 alert에서 제외 안내하므로 수용. **기록만.**

---

### [MINOR] m7 — history before/after 타입·whitelist 적합성
`app.js:4750-4754`(class), `5002-5007`(school)

두 곳 모두 `doc_id`(string)·`change_type:'UPDATE'`(enum 포함)·`before`/`after`(string)·`google_login_id`(string)·`timestamp`만 set. rules whitelist(firestore.rules:138-153 `hasAll`+`hasOnly`, change_type enum, size>0)와 **완전 일치**. `before: ${level}학교: ${c.before}` 등 항상 비어있지 않은 string. `google_login_id: currentUser?.email || '—'`로 size>0 보장. **위반 없음. OK.**

---

### [INFO] i8 — 공통 가드·배치·렌더 일관성 확인
- `isPastSemester()`·`selectedStudentIds.size===0` 가드: class(4672·이전)·school(4980·4981) 모두 존재. **OK.**
- 배치 200건 청크 + `await batch.commit()`: 양쪽 동일 패턴. **OK.**
- 렌더 호출: class는 `buildClassFilterSidebar()`+`applyFilterAndRender()`+`updateBulkEditSummary()`. school은 `resetBulkSchool()`+`applyFilterAndRender()`+`updateBulkEditSummary()`. 학교 변경은 반 사이드바 무관이라 `buildClassFilterSidebar` 생략 타당. **일관 OK.**
- `resetBulkClass`에 `bulk-class-startdate` 초기화 추가됨(4868-4870). 적용 성공 후에도 별도 초기화(4768-4769). **OK.**
- `resetBulkSchool`: 라디오 해제 + 학교명 input 비움. 적용 성공 시 호출. **OK.**

### [INFO] i9 — simplify 압축(confirm 이동·reduce) 정확성
`app.js:4986-4998`

simplify가 confirm을 `changes` 산출 뒤로 옮기고 `[...selectedStudentIds].reduce(...)`로 압축. reduce는 존재하는 학생만 `acc.push`. `changes.length===0` 가드가 그 뒤(4997)에서 confirm 전에 차단. confirm은 `selectedStudentIds.size` 모수 사용(m6 참조). **동작 동일·정확.** normalizeSchoolName 호출은 confirm 전(4990-4991)이라 정규화명이 confirm·history·write에 일관 사용. **OK.**

---

## normalizeSchoolName 의미 동일성 검증 (설계 §31)
`applyBulkSchool`(4990-4991): `normalizeSchoolName(rawName, level, collectKnownSchoolNames(allStudents))`.
`saveStudent`(2192·2206): `normalizeSchoolName(schoolByLevel[field], lv, collectKnownSchoolNames(allStudents))`.
→ **동일 시그니처·동일 knownSchools 소스.** import도 신규 시험지처럼 `normalizeStudentSchools` 경유와 결과 동등(safe suffix는 무조건, non-safe `초/중/고` 단일글자 접미는 knownSchools 포함 시만 제거). `SCHOOL_FIELD[level]` = `school_elementary|middle|high` 정확. **의미 일치 확인.**

---

## 심각도별 건수
- critical: 0
- major: 3 (M1 사양 의도 확인, M2 casing 회귀 위험, M3 stale-label 위험=정합 확인됨/기록)
- minor: 4 (m4 정합OK, m5 문구, m6 모수, m7 rules적합OK)
- info: 2

실질 수정 권고는 **M2(대소문자 정규화)** 1건이 회귀 위험으로 가장 중요. M1은 사양 의도 재확인. 나머지는 기록/선택.
