# 25. 내신 CS키 `.school` → `currentSchool` 동시 이전 — 정밀 분석

작성: 2026-05-30 · 상태: **분석 전용 (코드·데이터 미수정)**
범위: 블로커 ② (구 `school` 미러 제거 후속 1번) — DB+DSC 내신 CS키 동시 이전
근거: `_workspace/22`(line 13·31·35·37), `naesinHelpers.js`, `naesin-schedule.js`, `DailyLogBoard.jsx`, DSC `student-helpers.js`, `naesin.js`, `cleanup.js`, `syncNaesinPeriod.js`, shared `student-label.js`

---

## 0. 핵심 결론 (요약)

1. **키 생성 지점은 3곳이 아니라 4곳.** 영향분석 22가 짚은 3곳(DB fn `naesinHelpers`, DB front `naesin-schedule`, DSC React `DailyLogBoard`)에 더해 **DSC 루트 Vanilla `student-helpers.js:111` `deriveNaesinCode`** 가 실제 **csKey 생성·class_settings doc id 저장의 주체**다. 이 4번째가 누락되면 이전이 깨진다.
2. **키는 저장형이다.** csKey는 `class_settings/{csKey}` **doc id로 영속**되며(naesin 기간·스케줄 보관), Cloud Function(`cleanup`·`syncNaesinPeriod`)이 **런타임 재생성 키 === 저장 doc id** 비교로 매칭한다. 즉 "저장된 과거 키 ↔ 새로 생성하는 키"가 어긋나면 **고아 class_settings + 매칭 누락**이 발생.
3. **정상 학생은 무중단.** `.school`(미러) = `currentSchool(student)`(=`student.school_middle/high`)가 같은 값을 내는 동안에는 4곳 모두 동일 입력→동일 출력 → **키 보존**. 미러가 곧 현재 학부 학교명이므로 정상 데이터에서 키 변동 0.
4. **변동 위험은 stale 미러·미마이그레이션 doc 뿐.** 진급/졸업 시즌 미러 지연, `school_*` 미작성 doc(newtest 생산분 등)에서 `.school`≠`currentSchool` → 키가 바뀌어 **이미 저장된 class_settings doc과 불일치**. 이 케이스만 핀셋 대응 필요.
5. **Cloud Function 배포 필수.** `deriveNaesinCode`/`resolveNaesinCsKey`는 `functions/`(leave-request codebase)에 있고 `cleanup.js`·`syncNaesinPeriod.js`가 import. 변경 시 `firebase deploy --only functions:leave-request`(또는 `--only functions`) 필요.
6. **무중단 동시 이전 가능.** 단 "정상 학생 키 동일성"이라는 전제가 충족되는 한에서. 세 배포(DB functions + DB hosting + DSC hosting)는 **엄격한 원자성 불필요** — 키가 같은 값을 내므로 배포 윈도우 중 혼재해도 키 일치. 진짜 리스크는 배포 순서가 아니라 **stale 미러 doc**이다.
7. **위험도: 보통.** (영향분석 22의 "높음"은 블로커 3건 합산 기준. 키 동시 이전 단독으로는, 정상 데이터 키 보존이 보장되어 **보통**. 단 저장형 키라 사전 audit·stale 처리가 게이트.)

---

## 1. 네 곳 키 생성식 비교표

입력 학생 `s`, 정규/내신 enrollment `e`. 출력은 csKey(branch 접두 포함) 또는 그 코어(school+level+grade+group).

| # | 위치 | 파일:라인 | school 소스 | 정규화 | 코어 식 | branch 결합 | 용도 |
|---|------|----------|------------|--------|---------|------------|------|
| ① | DB fn (leave-request) | `functions/src/naesinHelpers.js:29,55` `deriveNaesinCode`/`buildNaesinCsKey` | `student.school` (raw) | **없음** | `${school}${levelShort}${grade}${group}` | `resolveNaesinCsKey`(58)에서 `branchFromStudent(s)+nCode` | **매칭(키 재생성)** — cleanup/syncNaesinPeriod |
| ② | DSC 루트 Vanilla | `student-helpers.js:112,140,152` `deriveNaesinCode`/`buildNaesinCsKey`/`resolveNaesinCsKey` | `student.school` (raw) | **없음** | `${school}${levelShort}${grade}${group}` | `resolveNaesinCsKey`(152)에서 `branchFromStudent(s)+nCode` | **키 생성·저장** — class_settings doc id 만듦(`naesin.js:41,1063,1084`) |
| ③ | DSC React | `DailyLogBoard.jsx:57-72` `buildNaesinKey` | `student.school` (raw) | **없음** | `${getBranch}${school}${levelShort}${grade}${group}` (한 함수에 branch까지 결합) | 함수 내부 `getBranch(student)` 접두 | **매칭(읽기)** — daily log 그룹·class_settings 조회 |
| ④ | DB front Vanilla | `naesin-schedule.js:22-33,69` `abbreviateSchool`+groupKey | `s.school` (raw) | groupKey는 raw, **label만 cleanSchoolName 축약** | groupKey=`${school}_${level}_${grade}` (group A/B·branch **없음**) | 없음 | **그룹핑+표시** (csKey 아님!) |

### 식 동일성 판정

- **①②③ 는 동일 입력→동일 출력**(csKey 의미에서). LEVEL_SHORT 매핑(`초/중/고`), grade, A/B group 판별 규칙(끝자리 홀=A·짝=B, A/B 직접표기 우선)이 글자 단위로 일치. branch도 ①②는 `resolveNaesinCsKey`에서, ③은 `getBranch`로 동일 규칙(1→2단지, 2→10단지).
  - **미묘한 차이(이번 이전과 무관, 기존부터 존재):** branch 유도 시 ①은 `regular?.class_number`(정규/자유학기 enrollment), ②③은 `enrollments[0].class_number`. 학생 enrollments[0]이 정규가 아닐 때 ①과 ②③이 갈릴 수 있으나 — 이는 **현행 코드의 기존 차이**이고 `.school`→`currentSchool` 이전으로 영향받지 않음(school 부분만 바뀜). 본 작업 범위 밖.
- **④(naesin-schedule.js)는 csKey가 아니다.** groupKey에 **branch·A/B group이 빠져** 있어 ①②③의 csKey와 형식이 다르다. 이건 class_settings doc id로 저장되지도, CF 매칭에 쓰이지도 않는 **DB 내신 시간표 모달 전용 로컬 그룹핑**(저장은 students.enrollments에 '내신' enrollment push, line 384). 따라서 **④의 `s.school`→`currentSchool` 치환은 매칭 무관·표시/그룹핑 한정**이라 위험 낮음. 영향분석 22가 ④를 "매칭+표시"로 분류했으나, 정밀히는 **csKey 매칭이 아닌 자체 그룹핑**이다.

> 결론: **진짜 동시 이전 대상은 ①②③(csKey 3곳)**. ④는 같은 윈도우에 함께 바꾸되 키 정합성 게이트와 무관(독립적으로 안전).

---

## 2. 키의 생애 — 저장형 (런타임 재생성 + doc id 영속의 하이브리드)

**csKey는 저장된다.** 흐름:

```
[생성·저장]  DSC naesin.js — resolveNaesinCsKey(②) → csKey
              → auditSet(doc(db,'class_settings', csKey), {naesin_start/end, schedule, teacher,...})
              → class_settings/{csKey} 가 Firestore에 영속 (doc id = csKey)

[매칭·소비]  · DSC React DailyLogBoard(③): buildNaesinKey → classSettings[key] 조회 (런타임 재생성 → 저장 doc 조회)
              · DSC 루트 naesin.js: resolveNaesinCsKey(②) → classSettings[csKey] 조회
              · DB front app.js/enrollment-derivation: e.naesin_class_override(저장 문자열) → cs[override]
              · DB fn cleanup(①): resolveNaesinCsKey(s,reg) === csKey(저장 doc id) 비교로 0명 판정
              · DB fn syncNaesinPeriod(①): e.naesin_class_override === csKey(변경된 doc id) 비교로 sync 대상 선정
```

함의:
- **즉석 재생성 키(①②③) 와 저장 doc id(과거 ②가 만든 값) 가 반드시 같아야** 조회·매칭이 성립.
- `naesin_class_override`(students.enrollments에 저장된 문자열)도 **과거 csKey 스냅샷**이다. override가 박힌 학생은 그 문자열이 그대로 매칭 키 → school 이전과 무관하게 보존(문자열 그대로 비교). **단 override가 가리키는 class_settings doc은 과거 school 기반 id**라, 그 doc을 새로 만들 일이 생기면 새 키와 갈릴 수 있음(드묾).
- 따라서 **기존 저장 키(.school 기반 class_settings doc id)는 마이그레이션 불필요** — 정상 학생은 새 키 == 기존 doc id 이므로. **stale 학생만** 새 키가 기존 doc과 어긋나 고아 발생.

---

## 3. currentSchool 이전 시 동일성·변동 케이스

`currentSchool(student) = student[SCHOOL_FIELD[student.level]]` (shared `student-label.js:12`). raw 값, **정규화 없음** — 키 식과 동일하게 raw를 쓰므로 치환 정합.

| 케이스 | `.school` | `currentSchool` | 키 영향 |
|--------|----------|----------------|--------|
| **정상 재원생** (미러=현재 학부 학교) | "신목중" | `school_middle`="신목중" | **동일 → 키 보존** ✅ |
| **진급 시즌 stale 미러** (학부필드 갱신됐으나 미러 지연) | 옛 학교 | 새 학교 | **키 변동** → 기존 class_settings doc과 불일치 |
| **`school_*` 미작성 doc** (newtest 신규 생성 등) | "OO중" | `''` (학부필드 없음) | `deriveNaesinCode`가 `!school`→`''` 반환 → **csKey null → 내신 매칭 자체 탈락** |
| **졸업/예측 학부** (고3→졸업) | 미러값 | `SCHOOL_FIELD[level]` (level='고등'이면 school_high) | level 기준이므로 대개 보존. 단 level과 미러 기준 학부가 다르면 변동 |

변동 시 영향:
- **class_settings 고아화:** 저장 doc id는 옛 키, 새 키는 다른 값 → cleanup이 "0명"으로 오판해 **활성 내신 반을 자동 삭제**할 위험(naesin_end+30일 grace라 즉시는 아님), syncNaesinPeriod가 **기간 sync 누락**.
- **daily log 내신 그룹 누락:** ③ buildNaesinKey가 새 키 생성 → classSettings[newKey] 없음 → 해당 학생 내신 정보 미표시.
- **단, 빈도 낮음:** 미러는 `onStudentLabelSync` 트리거가 write마다 `currentSchool→school` 갱신(22 §2)하므로 정상 운영 중 stale은 트리거 지연·실패 시에만. `school_*` 미작성 doc은 newtest 블로커(별도) 영역.

→ **사전 audit 필수:** 활성 내신 학생 중 `student.school !== currentSchool(student)`(또는 `school_*` 누락) 건수를 미리 집계. 0이면 무중단 즉시 가능, >0이면 그 건만 학부필드 백필 후 이전.

---

## 4. Cloud Function 영향 (배포 필요)

- 변경 대상 ①은 `functions/src/naesinHelpers.js`(leave-request codebase). import 체인:
  - `cleanup.js:9` → `resolveNaesinCsKey` (스케줄 cleanup, 0명 class_settings 자동삭제)
  - `syncNaesinPeriod.js` → csKey는 trigger doc id로 받고 `naesin_class_override === csKey` 비교(키 재생성 안 함. **school 직접 의존 없음** — override 문자열 비교만)
  - 단 `cleanup.js`의 `resolveNaesinCsKey(s,reg)` 는 **매번 재생성**하므로 `.school` 의존 직접 있음.
- 트리거/호출 경로:
  - `cleanup` = 스케줄(주기 실행) → 활성 학생 enrollment로 csKey 재생성 → 저장 doc id와 비교.
  - `syncNaesinPeriod` = `class_settings/{csKey}` onDocumentWritten(naesin_start/end 변경) → override 문자열 매칭.
- **frontend 키와 만나는 지점:** CF가 재생성한 키(①)와 DSC가 저장한 doc id(②)가 같아야 cleanup 판정·sync가 정확. 즉 **①과 ②는 글자 단위로 동일 유지가 생명**. 둘을 동일하게 `currentSchool`로 바꿔야 함.
- 배포: `firebase deploy --only functions:leave-request --project impact7db` (AGENTS.md상 `functions/`=leave-request codebase). `--only functions`는 shared까지 배포되니 지양.

---

## 5. 동시 배포 순서·무중단 전략

세 산출물: **(A) DB functions(leave-request)** ①, **(B) DB hosting** ④(+app.js 표시잔여), **(C) DSC hosting** ②③.

핵심 통찰: **정상 학생은 `.school`==`currentSchool` 이므로, A·B·C 어느 순서로 배포되든·혼재 시점에도 모든 키가 같은 값.** 키 불일치 윈도우가 **구조적으로 0**(전제: stale 0).

권장 순서 (안전 게이트 포함):
1. **Phase 0 — 사전 audit & 백필 (배포 전).** 활성 내신 대상 학생 전수에서 `student.school !== currentSchool` 또는 `school_*` 누락 건 집계. >0이면 해당 doc의 `school_middle/high` 백필(이미 미러가 곧 현재 학부라 대개 `school_*`=`.school` 복사). **audit 0 확인이 배포 게이트.**
2. **A·B·C 동시 배포** (순서 자유, 같은 윈도우 권장). 키가 동일값이므로 원자성 불요. 단 운영 혼선 줄이려 한 세션에 묶어 푸시.
3. **검증:** 배포 후 daily log 내신 그룹 카운트·class_settings 매칭 수가 배포 전과 동일한지 스냅샷 비교. cleanup은 다음 스케줄 전에 dry 확인(가능하면 `_countNaesinStudents`가 키 보존하는지 샘플 검증).

무중단 성립 조건:
- ✅ stale 미러 0 (Phase 0 게이트 통과).
- ✅ ①②③ 식이 글자 단위 동일하게 이전(school 토큰만 `currentSchool`로, 나머지 불변).
- ✅ 기존 class_settings doc id(과거 키)는 그대로 둠 — 새 키가 같은 값이라 재사용됨(마이그레이션 불요).
- ⚠ `naesin_class_override` 박힌 학생은 문자열 그대로 보존(영향 없음) — 단 그 override가 가리키는 doc은 옛 키, 새로 만들 일 없으면 무해.

배포 순서가 무의미한 이유: 한쪽(예: DSC만 먼저)이 `currentSchool`로 바뀌어도, 정상 학생은 그 값이 `.school`과 같아 **아직 안 바뀐 쪽(DB)이 만드는 `.school` 키와 일치**. 따라서 영향분석 22의 "한쪽만 바꾸면 키 어긋남"은 **stale 학생에 한해서만 참**이고, 정상 데이터에선 거짓. → **진짜 게이트는 동시성이 아니라 stale 제거.**

---

## 6. 위험도

- **수준: 보통.**
- 사유: 키는 저장형(class_settings doc id + naesin_class_override)이라 사전 audit 없이 강행 시 stale 학생에서 고아 class_settings·cleanup 오삭제·daily log 누락 가능. 그러나 정상 데이터는 `.school==currentSchool`로 키 보존되어 무중단 가능. CF 배포 1건 수반. **핵심 게이트는 Phase 0 stale audit(0 확인).**
- 상향 트리거: audit에서 stale/미작성 doc 다수 발견, 또는 newtest 블로커(school_* 미작성 생산) 미해결 → 그 경우 신규 doc이 계속 키 탈락하므로 **높음**으로 격상.

---

## 핵심 결론 (반환용)

내신 CS키 생성 지점은 **4곳**(영향분석 22의 3곳 + 누락된 DSC 루트 Vanilla `student-helpers.js:111`이 실제 저장 주체). 그중 csKey 정합이 필요한 건 **①DB fn `naesinHelpers` ②DSC 루트 `student-helpers` ③DSC React `DailyLogBoard`** 셋이고, 세 식은 `student.school`(정규화 없는 raw)을 글자 단위로 동일하게 키에 넣어 **동일 입력→동일 출력**이다(④ `naesin-schedule.js`는 branch·A/B 없는 자체 그룹핑이라 csKey 아님 → 매칭 무관, 함께 바꾸되 독립적으로 안전).

키는 **저장형**: csKey가 `class_settings/{csKey}` doc id로 영속되고 Cloud Function(`cleanup`·`syncNaesinPeriod`)이 런타임 재생성 키와 저장 doc id를 비교 매칭한다. `deriveNaesinCode`가 `functions/`(leave-request)에 있어 **변경 시 `firebase deploy --only functions:leave-request` 필요**.

**무중단 동시 이전은 가능하다 — 단 "정상 학생 `.school` == `currentSchool`"이 성립하는 한.** 정상 데이터에선 4곳이 같은 값을 내므로 A(DB fn)·B(DB hosting)·C(DSC hosting) 배포 **순서·원자성 불요**(키 불일치 윈도우 구조적 0). 진짜 게이트는 동시성이 아니라 **stale 미러·`school_*` 미작성 doc 제거**다: 배포 전 활성 내신 학생에서 `student.school !== currentSchool` 또는 `school_*` 누락 건을 audit해 **0을 확인(또는 백필)** 하면 무중단 성립. stale이 남으면 그 학생만 키가 어긋나 고아 class_settings·cleanup 오삭제·daily log 누락이 발생하므로, Phase 0 audit이 단일 안전 게이트다.
