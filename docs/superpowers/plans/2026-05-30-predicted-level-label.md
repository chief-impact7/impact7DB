# 예측 학부 기준 라벨 (Phase 2-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** studentFullLabel의 학교 lookup을 최종 기록 학부에서 "현재 예측 학부"로 바꿔, 진학/졸업 학생이 학교 미입력 시 "고1"·"고(졸업+6)"처럼 정확히 예측되게 한다.

**Architecture:** `@impact7/shared`의 `studentFullLabel`이 `normalizeRealLevelGrade` 예측 학부의 학교 필드를 읽고, 졸업은 학교 없으면 "고(졸업+N)". 미러 `school`은 최종 기록 학부 유지(다녔던 학교). 트리거 가드를 "학부별 필드 전무일 때만 skip"으로 완화. 전체 학생 백필.

**Tech Stack:** ESM 순수 JS(shared, node:test), Cloud Functions v2(functions-shared, vitest), admin SDK(백필).

**전제:** Phase 1(학부별 필드·트리거·v1.14.0) 완료·배포됨. status는 '퇴원' 유지(졸업 신규 없음). 전역 전환·school 제거는 별개 sub-project.

**⚠️ shared 버전:** 현재 1.14.0 → 이 작업 **v1.15.0**. 시작 전 `cd ~/projects/impact7-shared && grep '"version"' package.json && git tag | grep v1.15` 확인. [[feedback_shared_version_conflict]]

**작업 순서:** Task 1(shared) → 2(배포) → 3(트리거 가드) → 4(전체 백필).

---

## 파일 구조

| 파일 | 책임 | 작업 |
|------|------|------|
| `~/projects/impact7-shared/student-label.js` | studentFullLabel 예측 학부 학교 + 졸업 분기 | Modify |
| `~/projects/impact7-shared/student-label.test.js` | 예측/졸업 케이스 | Modify |
| `~/projects/impact7-shared/package.json` | v1.15.0 | Modify |
| `~/projects/impact7DB/functions-shared/src/studentLabelSync.js` | 가드 완화 | Modify |
| `~/projects/impact7DB/functions-shared/test/student-label-sync.test.js` | 가드 케이스 | Modify |
| `~/projects/impact7DB/functions-shared/package.json` | shared v1.15.0 | Modify |
| `~/projects/impact7DB/migrate-school-by-level.js` | 현재학기 제한 해제(전체) | Modify |
| `~/projects/impact7DB/package.json` | shared v1.15.0 | Modify |

---

## Task 1: shared — studentFullLabel 예측 학부 기준 (TDD)

**Files:** Modify `~/projects/impact7-shared/student-label.js`, `student-label.test.js`

작업 디렉토리: `cd ~/projects/impact7-shared`

- [ ] **Step 1: 테스트 갱신/추가** — `student-label.test.js`

기존 졸업 케이스(`한국고등학교 고4 → 한국고(졸업+1)`)는 입력을 `school_high`로 유지(`SL('고등', 4, { school_high: '한국고등학교' })` → `한국고(졸업+1)`). 누적 케이스(`초등 11 → 한국고2`)는 입력 학교를 예측 학부(고등) 필드로 옮긴다: `SL('초등', 11, { school_high: '한국고등학교' })` → `한국고2` (예측 학부 고등의 학교를 읽으므로). 파일 끝에 추가:
```js
test('누적 중등7 + 고 학교 미입력 → 고(졸업+1) (학교 없이)', () => {
  assert.equal(studentFullLabel(SL('중등', 7, { school_middle: '봉영여' })), '고(졸업+1)');
});
test('중등4 + 고 학교 미입력 → 고1 (진학 예측, 중4 아님)', () => {
  assert.equal(studentFullLabel(SL('중등', 4, { school_middle: '봉영여' })), '고1');
});
test('중등4 + 고 학교 입력 → 대일고1', () => {
  assert.equal(studentFullLabel(SL('중등', 4, { school_middle: '봉영여', school_high: '대일' })), '대일고1');
});
test('봉영여중3 (예측=기록 중등) → 봉영여중3 (무영향)', () => {
  assert.equal(studentFullLabel(SL('중등', 3, { school_middle: '봉영여중' })), '봉영여중3');
});
test('졸업 + 고 학교 없음 → 고(졸업+6)', () => {
  assert.equal(studentFullLabel(SL('중등', 12, { school_middle: '봉영여' })), '고(졸업+6)');
});
```
> `normalizeRealLevelGrade`: 중등 base=6. grade 4→10(고1), 7→13(졸업+1), 12→18(졸업+6).

- [ ] **Step 2: 실패 확인**
Run: `cd ~/projects/impact7-shared && node --test student-label.test.js`
Expected: FAIL — 현재는 currentSchool(student.level=중등→school_middle)을 읽어 "봉영여고(졸업+1)" 등.

- [ ] **Step 3: `studentFullLabel` 교체** (student-label.js의 해당 함수만)
```js
export function studentFullLabel(student) {
  const norm = normalizeRealLevelGrade(student || {});
  const predLevel = norm.graduated ? '고등' : norm.level;
  const school = normalizeSchoolForLabel(student?.[SCHOOL_FIELD[predLevel]] || '');
  const lv = LEVEL_SHORT[predLevel] || '';
  const dup = lv && school.endsWith(lv) && !DUP_EXCEPT.has(school);
  const lvPart = dup ? '' : lv;
  if (norm.graduated) return `${school}${lvPart}(졸업+${norm.grade})`;
  return `${school}${lvPart}${norm.grade ? String(norm.grade) : ''}`;
}
```
변경점: 학교를 `currentSchool` 대신 `student[SCHOOL_FIELD[predLevel]]`(예측 학부)에서 읽음. `lv`도 predLevel 기준(졸업이면 '고'). 졸업 분기를 school 유무 무관 `${school}${lvPart}(졸업+N)`로 단일화 — school 비면 "고(졸업+N)".
> `currentSchool`/`SCHOOL_FIELD`/`normalizeRealLevelGrade`/`normalizeSchoolForLabel`/`LEVEL_SHORT`/`DUP_EXCEPT`는 기존 그대로 둔다(currentSchool은 미러용으로 계속 export).

- [ ] **Step 4: 통과 확인** — 기존 케이스 입력을 예측 학부 필드로 맞춘 뒤
Run: `cd ~/projects/impact7-shared && node --test student-label.test.js`
Expected: PASS (전체)

- [ ] **Step 5: 버전 + 커밋**
`package.json` `1.14.0` → `1.15.0`.
```bash
cd ~/projects/impact7-shared
git add student-label.js student-label.test.js package.json
git commit -m "feat: studentFullLabel 예측 학부 기준 학교 + 졸업 고(졸업+N) v1.15.0"
```
**PUSH 금지**(Task 2).

---

## Task 2: shared 배포 (v1.15.0)

- [ ] **Step 1: 전체 테스트**
Run: `cd ~/projects/impact7-shared && node --test`
Expected: PASS

- [ ] **Step 2: 태그 + 푸시** (⚠️ 외부 — controller가 사용자 확인 후)
```bash
cd ~/projects/impact7-shared
git tag v1.15.0
git push origin main && git push origin v1.15.0
```

---

## Task 3: functions-shared — 트리거 가드 완화

**Files:** Modify `~/projects/impact7DB/functions-shared/{package.json, src/studentLabelSync.js, test/student-label-sync.test.js}`

작업 디렉토리: `cd ~/projects/impact7DB/functions-shared`

- [ ] **Step 1: shared v1.15.0**
`package.json`의 `@impact7/shared`를 `#v1.15.0`로.
```bash
cd ~/projects/impact7DB/functions-shared
npm install @impact7/shared@github:chief-impact7/impact7-shared#v1.15.0
node -e "import('@impact7/shared/student-label').then(m=>console.log(typeof m.studentFullLabel))"
```
Expected: `function`. (`readlink node_modules/@impact7/shared` 링크 아닌지, lock resolved v1.15.0 커밋 확인. 링크면 rm -rf 후 재설치.)

- [ ] **Step 2: 테스트 추가** — `test/student-label-sync.test.js` describe 안에
```js
  it('진학 예측(고 학교 없음)도 라벨 생성 — 학부 필드 하나라도 있으면', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 7, school_middle: '봉영여', school_level_grade: '구값' });
    expect(r.school_level_grade).toBe('고(졸업+1)');
  });
  it('학부별 필드 전무 → null (미마이그레이션만 skip)', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school: '봉영여중', school_level_grade: '봉영여중1' });
    expect(r).toBeNull();
  });
```
> 기존 "currentSchool 빈값이면 null" 테스트는 의미가 바뀌었으니(이제 학부필드 유무 기준) 위 두 케이스로 대체/갱신. 기존 "school 미러+label 둘 다"·"둘 다 같으면 null" 케이스는 학부필드(school_middle 등)가 있으므로 그대로 통과하도록 유지.

- [ ] **Step 3: `src/studentLabelSync.js` 교체**
```js
import { studentFullLabel, currentSchool } from '@impact7/shared/student-label';

// 변경 후 문서 데이터 → 갱신할 필드(school 미러 + school_level_grade). 변경 없으면 null.
export function computeLabelUpdate(data) {
  // 학부별 필드가 하나도 없으면 미마이그레이션 → skip(기존값 보존).
  const hasAnySchool = !!(data?.school_elementary || data?.school_middle || data?.school_high);
  if (!hasAnySchool) return null;
  const update = {};
  const mirror = currentSchool(data);
  if (data?.school !== mirror) update.school = mirror;
  const label = studentFullLabel(data);
  if (data?.school_level_grade !== label) update.school_level_grade = label;
  return Object.keys(update).length ? update : null;
}
```

- [ ] **Step 4: 테스트 통과 + 커밋**
Run: `cd ~/projects/impact7DB/functions-shared && npx vitest run test/student-label-sync.test.js`
Expected: 통과 (갱신된 케이스 포함)
```bash
git add package.json index.js src/studentLabelSync.js test/student-label-sync.test.js
git commit -m "feat: 트리거 가드를 학부필드 유무로 완화 (진학/졸업 예측 라벨 생성, shared v1.15.0)"
```

- [ ] **Step 5: 배포** (⚠️ controller가 사용자 확인 후)
Run: `cd ~/projects/impact7DB && firebase deploy --only functions:shared --project impact7db`

---

## Task 4: 전체 백필

**Files:** Modify `~/projects/impact7DB/migrate-school-by-level.js`, `package.json`

작업 디렉토리: `cd ~/projects/impact7DB`

- [ ] **Step 1: DB shared v1.15.0**
`package.json`의 `@impact7/shared`를 `#v1.15.0`로.
```bash
npm install @impact7/shared@github:chief-impact7/impact7-shared#v1.15.0
node -e "import('@impact7/shared/student-label').then(m=>console.log(typeof m.studentFullLabel))"
```
Expected: `function`. (링크 아닌지·lock v1.15.0 확인.)

- [ ] **Step 2: 백필 스크립트 — 현재 학기 제한 해제(전체)** (`migrate-school-by-level.js`)
`CURRENT_SEMS`/`inCurrentSem` 필터를 제거하고 전체 학생 대상으로. forEach 본문을:
```js
snap.forEach(d => {
  const x = d.data();
  const field = SCHOOL_FIELD[x.level];
  const update = {};
  // single school → 최종 기록 학부 필드 (해당 학부 필드 비어있고 school 있으면)
  if (field && !x[field] && x.school) update[field] = x.school;
  const merged = { ...x, ...update };
  const label = studentFullLabel(merged);
  if (x.school_level_grade !== label) update.school_level_grade = label;
  const mirror = currentSchool(merged);
  if (x.school !== mirror) update.school = mirror;
  // 학부별 필드가 하나도 없으면(원본 school도 없음) skip
  const hasAnySchool = !!(merged.school_elementary || merged.school_middle || merged.school_high);
  if (hasAnySchool && Object.keys(update).length) changes.push({ id: d.id, ref: d.ref, update });
});
```
(상단의 `ACTIVE`/`CURRENT_SEMS` 관련 줄 삭제. import는 `studentFullLabel, currentSchool, SCHOOL_FIELD` 유지. 출력 표본에 `(졸업+` 포함 건수도 보고하도록 로그 추가.)

- [ ] **Step 3: dry-run**
Run: `cd ~/projects/impact7DB && npm run migrate:schoollevel`
Expected: 전체 대상 건수 + "(졸업+" 라벨 건수 + 표본. 졸업생이 "고(졸업+N)"(학교 없이) 또는 "대일고(졸업+N)"(고 학교 입력시)로 나오는지 확인.

- [ ] **Step 4: 사용자 승인 후 실제 백필** (⚠️ 대량 — [[feedback_no_autonomous_batch]])
dry-run 결과 보고 → 승인 후: `npm run migrate:schoollevel:run`

- [ ] **Step 5: 커밋**
```bash
cd ~/projects/impact7DB
git add migrate-school-by-level.js package.json package-lock.json
git commit -m "feat: 예측 학부 기준 라벨 전체 백필 (현재학기 제한 해제, @impact7/shared v1.15.0)"
```

---

## Self-Review (작성자 점검)

**Spec 커버리지:**
- studentFullLabel 예측 학부 학교 → Task 1 ✓
- 졸업 "고(졸업+N)" 학교 없이 → Task 1 졸업 분기 단일화 ✓
- 미러 currentSchool(최종 기록) 유지 → Task 1 currentSchool 미변경, Task 3 미러 ✓
- 트리거 가드 완화(학부필드 유무) → Task 3 ✓
- 전체 백필 → Task 4 ✓
- status 퇴원 유지(졸업 신규 없음) → 어느 Task도 status 안 건드림 ✓
- 비목표(전역 전환·school 제거) → 계획에 없음 ✓

**타입 일관성:** `predLevel`·`SCHOOL_FIELD[predLevel]`·`studentFullLabel`·`computeLabelUpdate(data)`·`currentSchool` 시그니처 Task 1·3·4 일치 ✓.

**미해결(구현 중):**
- Task 1에서 기존 16+개 테스트 중 학교 입력이 student.level과 예측 학부가 다른 케이스(누적)는 입력을 예측 학부 필드로 옮겨야 함 — 정상 데이터(level=예측) 케이스는 무영향.
- 미러 `school`이 currentSchool(최종 기록 학부) 빈값일 때 `school:''` 갱신될 수 있음(해당 학부 미입력). 학부필드 가드 통과 시 발생 — 의도(미러는 최종 기록 학부 학교, 없으면 빈값).
