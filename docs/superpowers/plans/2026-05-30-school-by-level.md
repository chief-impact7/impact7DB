# 학부별 학교명(Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학생 학교명을 학부별 필드(school_elementary/middle/high)로 보존하고, currentSchool 기반으로 라벨/미러를 동기화하며, 정규화 규칙(약어·지역명·예외)을 적용한다.

**Architecture:** `@impact7/shared`에 `currentSchool`·`SCHOOL_FIELD`를 추가하고 `studentFullLabel`을 currentSchool 기반 + 정규화 정교화로 v1.14.0 업데이트. 트리거가 `school`(미러) + `school_level_grade`를 동기화. DB는 학부별 입력·저장·승급·마이그레이션. 기존 `school`은 미러로 유지(전역 앱 호환), 제거는 Phase 2.

**Tech Stack:** ESM 순수 JS(shared, node:test), Cloud Functions v2(functions-shared, vitest), Vanilla JS+Firestore(DB), admin SDK(마이그레이션).

**전환 결정(미결 확정):** ① 라벨 백필은 **활성 재원생만**(재원/등원예정/실휴원/가휴원) — 퇴원생 grade 누적 졸업오판 회피. ② DB 내부 표시(.school 읽기)는 **미러 school 유지**로 최소 변경, currentSchool 전환은 Phase 2.

**⚠️ shared 버전:** 현재 1.13.0 → 이 작업 **v1.14.0**. 시작 전 `cd ~/projects/impact7-shared && grep '"version"' package.json && git tag | grep v1.14` 확인. [[feedback_shared_version_conflict]]

**작업 순서:** Task 1(shared) → 2(배포) → 3(트리거) → 4(DB 입력/저장) → 5(학년승급) → 6(마이그레이션+백필).

---

## 파일 구조

| 파일 | 책임 | 작업 |
|------|------|------|
| `~/projects/impact7-shared/student-label.js` | currentSchool·SCHOOL_FIELD·정규화·studentFullLabel | Modify |
| `~/projects/impact7-shared/student-label.test.js` | 정규화 규칙 테스트 확장 | Modify |
| `~/projects/impact7-shared/package.json` | v1.14.0 | Modify |
| `~/projects/impact7DB/functions-shared/src/studentLabelSync.js` | school 미러 + label 동기화 | Modify |
| `~/projects/impact7DB/functions-shared/test/student-label-sync.test.js` | 미러 테스트 추가 | Modify |
| `~/projects/impact7DB/functions-shared/package.json` | shared v1.14.0 | Modify |
| `~/projects/impact7DB/index.html` | 학부별 입력칸(현재+접기) | Modify |
| `~/projects/impact7DB/app.js` | submitNewStudent 저장, 학년승급, package | Modify |
| `~/projects/impact7DB/migrate-school-by-level.js` | single→학부별 + 라벨 백필 | Create |

---

## Task 1: shared — currentSchool + 정규화 정교화 (TDD)

**Files:**
- Modify: `~/projects/impact7-shared/student-label.js`
- Test: `~/projects/impact7-shared/student-label.test.js`

작업 디렉토리: `cd ~/projects/impact7-shared`

- [ ] **Step 1: 테스트 확장** — `student-label.test.js`에 아래 케이스 추가(기존 16개 유지, import 줄에 currentSchool 추가)

import 줄 교체:
```js
import { studentFullLabel, normalizeRealLevelGrade, currentSchool } from './student-label.js';
```
기존 `const S = (school, level, grade) => ({ school, level, grade });` 아래에 추가:
```js
// 학부별 필드 헬퍼
const SL = (level, grade, schools) => ({ level, grade, ...schools });
```
파일 끝에 테스트 추가:
```js
test('currentSchool: 현재 학부 필드 반환', () => {
  assert.equal(currentSchool({ level: '중등', school_middle: '봉영여중', school_elementary: '양명초' }), '봉영여중');
});
test('currentSchool: 해당 학부 빈값이면 빈 문자열', () => {
  assert.equal(currentSchool({ level: '고등', school_middle: '봉영여중' }), '');
});

test('label: currentSchool 기반 (중등 → school_middle)', () => {
  assert.equal(studentFullLabel(SL('중등', 1, { school_middle: '봉영여자중학교' })), '봉영여중1');
});
test('지역명 제거: 서울목동중 → 목동중', () => {
  assert.equal(studentFullLabel(SL('중등', 2, { school_middle: '서울목동중' })), '목동중2');
});
test('지역명+학부만 → 원복: 서울중 → 서울중', () => {
  assert.equal(studentFullLabel(SL('중등', 1, { school_middle: '서울중' })), '서울중1');
});
test('지역명 풀네임: 서울중학교 → 서울중', () => {
  assert.equal(studentFullLabel(SL('중등', 1, { school_middle: '서울중학교' })), '서울중1');
});
test('예외 서초: 서초 → 서초초 (학부글자 유지)', () => {
  assert.equal(studentFullLabel(SL('초등', 3, { school_elementary: '서초' })), '서초초3');
});
test('예외 안중: 안중 → 안중중', () => {
  assert.equal(studentFullLabel(SL('중등', 2, { school_middle: '안중' })), '안중중2');
});
test('일반 약어 양명초 → 양명초6 (중복 제거)', () => {
  assert.equal(studentFullLabel(SL('초등', 6, { school_elementary: '양명초' })), '양명초6');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ~/projects/impact7-shared && node --test student-label.test.js`
Expected: FAIL — `currentSchool` 미export, label이 school_middle 못 읽음.

- [ ] **Step 3: `student-label.js` 교체**

```js
// 학생의 학교+학부+학년 라벨("봉영여중1") 단일 소스. 순수 함수.
const LEVEL_CUMULATIVE_START = { '초등': 0, '중등': 6, '고등': 9 };
const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };
export const SCHOOL_FIELD = { '초등': 'school_elementary', '중등': 'school_middle', '고등': 'school_high' };
const SCHOOL_ABBR = [['사범대부속', '사대부'], ['여자', '여'], ['외국어', '외'], ['부속', '부']];
// 광역시/도 — 학교명 앞 지역명 prefix 제거용.
const REGIONS = ['서울', '경기', '인천', '부산', '대구', '광주', '대전', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
// 학교명이 학부글자로 끝나지만 그 글자가 학부가 아닌 예외(학부글자 유지).
const DUP_EXCEPT = new Set(['서초', '활초', '소초', '속초', '시초', '도초', '백초', '생초', '연초', '윤중', '안중', '영중', '운중', '아중']);

// 현재 학부의 학교명. 학부별 필드(school_elementary/middle/high)에서 현재 level 것.
export function currentSchool(student) {
  return student?.[SCHOOL_FIELD[student?.level]] || '';
}

export function normalizeRealLevelGrade(s) {
  const gradeNum = parseInt(s?.grade, 10);
  if (isNaN(gradeNum) || gradeNum <= 0) return { level: s?.level || '초등', grade: 0, graduated: false };
  const base = LEVEL_CUMULATIVE_START[s.level] ?? 0;
  const cumulative = base + gradeNum;
  if (cumulative <= 6)  return { level: '초등', grade: cumulative,     graduated: false };
  if (cumulative <= 9)  return { level: '중등', grade: cumulative - 6, graduated: false };
  if (cumulative <= 12) return { level: '고등', grade: cumulative - 9, graduated: false };
  return { level: '졸업', grade: cumulative - 12, graduated: true };
}

function normalizeSchoolForLabel(name) {
  let s = String(name || '').trim().replace(/\s+/g, ' ');
  s = s.replace(/(초등학교|중학교|고등학교|학교)$/, '').trim();
  for (const [a, b] of SCHOOL_ABBR) s = s.split(a).join(b);
  // 지역명 prefix 제거. 단 제거 후 빈값이거나 학부글자(초/중/고) 한 글자뿐이면 원복.
  for (const r of REGIONS) {
    if (s.startsWith(r) && s.length > r.length) {
      const rest = s.slice(r.length);
      if (rest && !/^[초중고]$/.test(rest)) s = rest;
      break;
    }
  }
  return s;
}

export function studentFullLabel(student) {
  const norm = normalizeRealLevelGrade(student || {});
  const school = normalizeSchoolForLabel(currentSchool(student));
  const lv = LEVEL_SHORT[norm.graduated ? '고등' : norm.level] || '';
  const dup = lv && school.endsWith(lv) && !DUP_EXCEPT.has(school);
  const lvPart = dup ? '' : lv;
  if (norm.graduated) return school ? `${school}${lvPart}(졸업+${norm.grade})` : `졸업+${norm.grade}`;
  return `${school}${lvPart}${norm.grade ? String(norm.grade) : ''}`;
}
```

> 주의: 기존 16개 테스트 중 `S('봉영여자중학교','중등',1)`처럼 `school` 평면 필드로 넘기던 케이스는 이제 currentSchool이 `school_middle`을 보므로 라벨에 학교가 안 잡힌다. **기존 테스트의 `S(...)` 입력을 `SL(level, grade, { school_<level>: ... })` 형태로 바꾸거나, 그 케이스들을 currentSchool 기준으로 갱신**해야 한다. (졸업 케이스 `한국고등학교`도 `school_high`로.)

- [ ] **Step 4: 테스트 통과 확인** — 기존 케이스를 학부별 입력으로 갱신 후

Run: `cd ~/projects/impact7-shared && node --test student-label.test.js`
Expected: PASS (전체)

- [ ] **Step 5: 버전 + 커밋**

`package.json` version `1.13.0` → `1.14.0`.
```bash
cd ~/projects/impact7-shared
git add student-label.js student-label.test.js package.json
git commit -m "feat: studentFullLabel currentSchool 기반 + 정규화(지역명·예외14) v1.14.0"
```
**PUSH 금지** (Task 2에서).

---

## Task 2: shared 배포 (v1.14.0)

- [ ] **Step 1: 전체 테스트**
Run: `cd ~/projects/impact7-shared && node --test`
Expected: PASS

- [ ] **Step 2: 태그 + 푸시** (⚠️ 외부 — controller가 사용자 확인 후)
```bash
cd ~/projects/impact7-shared
git tag v1.14.0
git push origin main && git push origin v1.14.0
```

---

## Task 3: functions-shared — 트리거에 school 미러 추가

**Files:**
- Modify: `~/projects/impact7DB/functions-shared/package.json`, `src/studentLabelSync.js`, `test/student-label-sync.test.js`

작업 디렉토리: `cd ~/projects/impact7DB/functions-shared`

- [ ] **Step 1: shared v1.14.0**
`package.json`의 `@impact7/shared`를 `#v1.14.0`로.
```bash
cd ~/projects/impact7DB/functions-shared
npm install @impact7/shared@github:chief-impact7/impact7-shared#v1.14.0
node -e "import('@impact7/shared/student-label').then(m=>console.log(typeof m.currentSchool, typeof m.studentFullLabel))"
```
Expected: `function function`. (`readlink node_modules/@impact7/shared`로 링크 아닌지 확인. lock resolved가 v1.14.0 커밋인지.)

- [ ] **Step 2: 테스트 추가** — `test/student-label-sync.test.js`의 describe 안에 추가
```js
  it('school 미러 + label 둘 다 갱신', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '구값', school_level_grade: '구값' });
    expect(r).toEqual({ school: '봉영여중', school_level_grade: '봉영여중1' });
  });
  it('둘 다 같으면 null', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '봉영여중', school_level_grade: '봉영여중1' });
    expect(r).toBeNull();
  });
  it('currentSchool 빈값이면 null (미마이그레이션 보호)', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school: '봉영여중', school_level_grade: '봉영여중1' });
    expect(r).toBeNull();
  });
```

- [ ] **Step 3: `src/studentLabelSync.js` 교체**
```js
import { studentFullLabel, currentSchool } from '@impact7/shared/student-label';

// 변경 후 문서 데이터 → 갱신할 필드(school 미러 + school_level_grade). 변경 없으면 null.
export function computeLabelUpdate(data) {
  const mirror = currentSchool(data);
  // 가드: 현재 학부 학교가 비어있으면(미마이그레이션/미입력) 동기화 skip.
  // 마이그레이션 전 학부별 필드가 없는 기존 학생의 school_level_grade를 "중1"로 파괴하는 것을 방지.
  if (!mirror) return null;
  const update = {};
  if (data?.school !== mirror) update.school = mirror;
  const label = studentFullLabel(data);
  if (data?.school_level_grade !== label) update.school_level_grade = label;
  return Object.keys(update).length ? update : null;
}
```
(트리거 핸들러 `index.js`의 onStudentLabelSync는 그대로 — `computeLabelUpdate` 결과를 update.)

> **순서 안전성**: 이 가드 덕에 트리거 v1.14.0 배포가 마이그레이션보다 먼저 와도, 학부별 필드가 없는 기존 학생은 `currentSchool=''`라 트리거가 건너뛴다(기존 라벨 보존). 마이그레이션이 학부별 필드를 채운 뒤에야 라벨이 정상 동기화된다.

- [ ] **Step 4: 테스트 통과 + 커밋**
Run: `cd ~/projects/impact7DB/functions-shared && npx vitest run test/student-label-sync.test.js`
Expected: 4 passed
```bash
git add package.json index.js src/studentLabelSync.js test/student-label-sync.test.js
git commit -m "feat: 트리거에 school 미러 동기화 추가 (currentSchool, shared v1.14.0)"
```

- [ ] **Step 5: 배포** (⚠️ controller가 사용자 확인 후)
Run: `cd ~/projects/impact7DB && firebase deploy --only functions:shared --project impact7db`

---

## Task 4: DB — 학부별 입력 UI + 저장

**Files:**
- Modify: `~/projects/impact7DB/index.html` (폼 school 입력, 약 682행)
- Modify: `~/projects/impact7DB/app.js` (`submitNewStudent` ~2172, package.json)

작업 디렉토리: `cd ~/projects/impact7DB`

- [ ] **Step 1: DB shared v1.14.0**
`package.json`의 `@impact7/shared`를 `#v1.14.0`로.
```bash
npm install @impact7/shared@github:chief-impact7/impact7-shared#v1.14.0
node -e "import('@impact7/shared/student-label').then(m=>console.log(typeof m.currentSchool))"
```
Expected: `function`. import 추가가 필요하면 app.js 상단 `@impact7/shared/...` import 블록에 `currentSchool, SCHOOL_FIELD`를 추가(현재 promo-extractor-core의 것과 충돌 없게 shared에서).

- [ ] **Step 2: 입력 UI** — `index.html`의 `<input ... name="school" ...>`(약 682행)을 학부별로 교체

기존 한 칸을 "현재 학부 칸 + 이전 학부 접기"로. 기존 폼 필드 마크업 스타일(class="field-input")을 따라:
```html
<input class="field-input" name="school_current" type="text" placeholder="현재 학부 학교 (예: 봉영여중)">
<details class="prev-school-fold" style="margin-top:6px;">
  <summary style="cursor:pointer;font-size:13px;color:#888;">이전 학부 학교 입력</summary>
  <input class="field-input" name="school_elementary" type="text" placeholder="초등 학교명" style="margin-top:6px;">
  <input class="field-input" name="school_middle" type="text" placeholder="중등 학교명" style="margin-top:6px;">
  <input class="field-input" name="school_high" type="text" placeholder="고등 학교명" style="margin-top:6px;">
</details>
```
> `school_current`는 현재 level의 학교를 입력하는 편의 칸. 저장 시 현재 level의 학부별 필드로 매핑된다. 접기 안의 3칸은 이전/타 학부 직접 입력용.

- [ ] **Step 3: `submitNewStudent` 저장 로직** (app.js ~2178-2186, 2181의 normalizeSchoolName 사용 부분과 studentData 구성)

`const school = normalizeSchoolName(f.school.value, level, knownSchools);` 부분과 school 검증·저장을 아래로 교체:
```js
    const SCHOOL_FIELD = { '초등': 'school_elementary', '중등': 'school_middle', '고등': 'school_high' };
    // 현재 학부 칸(school_current) → 현재 level의 학부별 필드. 접기 3칸은 직접 입력.
    const curField = SCHOOL_FIELD[level];
    const schoolByLevel = {
        school_elementary: (f.school_elementary?.value || '').trim(),
        school_middle: (f.school_middle?.value || '').trim(),
        school_high: (f.school_high?.value || '').trim(),
    };
    const curInput = (f.school_current?.value || '').trim();
    if (curInput && curField) schoolByLevel[curField] = curInput;
    // 현재 학부 학교는 정규화(기존 normalizeSchoolName 규칙) 적용
    if (curField) schoolByLevel[curField] = normalizeSchoolName(schoolByLevel[curField], level, knownSchools);
    const school = schoolByLevel[curField] || ''; // 미러용 현재 학부 학교
```
검증 `if (!school)`는 유지(현재 학부 학교 필수). `studentData`에 학부별 + 미러 추가:
```js
        // (studentData 객체 구성부에 추가)
        ...schoolByLevel,
        school, // 미러(현재 학부) — Phase 2에서 제거 예정
```
> 편집 모드(isEditMode) 저장부에도 동일하게 `...schoolByLevel, school` 포함. 폼 로드(openEditor)에서 `f.school_current.value = currentSchool(student)`, 접기 칸은 각 학부별 필드값으로 채운다.

- [ ] **Step 4: 빌드**
Run: `cd ~/projects/impact7DB && npx vite build`
Expected: 성공.

- [ ] **Step 5: 커밋**
```bash
git add index.html app.js package.json package-lock.json
git commit -m "feat: 학부별 학교명 입력/저장 (현재 학부 칸 + 이전 학부 접기, @impact7/shared v1.14.0)"
```

---

## Task 5: DB — 학년 승급 학부별 전환

**Files:**
- Modify: `~/projects/impact7DB/app.js` (`applyBulkPromotion` ~4778-4856)

- [ ] **Step 1: 학부 전환 시 학부별 필드로** (app.js:4798-4816, 4855)

학부 전환 블록과 updateData 구성을 학부별 필드 기준으로 수정. `afterSchool`/`updateData.school` 단일 처리를 아래로 교체:
```js
        const SCHOOL_FIELD = { '초등': 'school_elementary', '중등': 'school_middle', '고등': 'school_high' };
        let afterLevel = oldLevel;
        let afterGrade = oldGrade + 1;
        let isTransition = false;
        const updateData = { grade: afterGrade };

        if (oldGrade >= maxG) {
            const next = NEXT_LEVEL[oldLevel];
            if (!next) { skipped.push(`${student.name} (고${oldGrade} — 졸업 대상)`); return; }
            afterLevel = next;
            afterGrade = 1;
            isTransition = true;
            updateData.level = next;
            updateData.grade = 1;
            // 새 학부 학교는 newSchool 입력 시 그 학부 필드에, 없으면 빈값(이전 학부 필드는 보존)
            if (newSchool) updateData[SCHOOL_FIELD[next]] = newSchool;
            updateData.school = newSchool || ''; // 미러는 새 학부 기준(빈값이면 비움)
        }
        const oldSchool = student[SCHOOL_FIELD[oldLevel]] || student.school || '';
        const afterSchool = isTransition ? (newSchool || '') : oldSchool;
        const beforeParts = [oldLevel, `${oldGrade}학년`, oldSchool].filter(Boolean).join(' ');
        const afterParts = [afterLevel, `${afterGrade}학년`, afterSchool].filter(Boolean).join(' ');
        changes.push({ id, name: student.name, before: beforeParts, after: afterParts, updateData, afterLevel, afterGrade, isTransition });
```
로컬 동기화(4850-4857)도 updateData 반영:
```js
        changes.forEach(c => {
            const s = allStudents.find(s => s.id === c.id);
            if (s) Object.assign(s, c.updateData);
        });
```
> 이전 학부 필드(school_elementary 등)는 건드리지 않아 보존됨. 트리거가 미러 school도 재동기화한다.

- [ ] **Step 2: 빌드 + 커밋**
Run: `cd ~/projects/impact7DB && npx vite build` → 성공.
```bash
git add app.js
git commit -m "feat: 학년 승급 학부 전환을 학부별 필드로 (이전 학부 보존)"
```

---

## Task 6: 마이그레이션 (single→학부별 + 라벨 백필)

**Files:**
- Create: `~/projects/impact7DB/migrate-school-by-level.js`

- [ ] **Step 1: 스크립트 작성** — `migrate-school-by-level.js` (migrate-school-label.js의 admin 초기화 패턴 재사용)

```js
import admin from 'firebase-admin';
import { studentFullLabel, currentSchool, SCHOOL_FIELD } from '@impact7/shared/student-label';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(resolve(__dirname, 'service-account.json'), 'utf8'))), projectId: 'impact7db' });
const db = admin.firestore();
const RUN = process.argv.includes('--run');
const ACTIVE = new Set(['재원', '등원예정', '실휴원', '가휴원']);

const snap = await db.collection('students').get();
const changes = [];
snap.forEach(d => {
  const x = d.data();
  const field = SCHOOL_FIELD[x.level];
  const update = {};
  // single school → 현재 학부 필드 (해당 학부 필드가 비어있고 school이 있으면)
  if (field && !x[field] && x.school) update[field] = x.school;
  // 라벨은 활성 재원생만 (퇴원생 grade 누적 졸업오판 회피)
  if (ACTIVE.has(x.status)) {
    const merged = { ...x, ...update };
    const label = studentFullLabel(merged);
    if (x.school_level_grade !== label) update.school_level_grade = label;
    const mirror = currentSchool(merged);
    if (x.school !== mirror && mirror) update.school = mirror;
  }
  if (Object.keys(update).length) changes.push({ id: d.id, ref: d.ref, update, status: x.status });
});

const active = changes.filter(c => ACTIVE.has(c.status)).length;
console.log(`대상 ${changes.length}/${snap.size}건 (활성 라벨 ${active})`);
changes.slice(0, 20).forEach(c => console.log(`  ${c.id}: ${JSON.stringify(c.update)}`));
if (!RUN) { console.log('\n[dry-run] --run 으로 반영'); process.exit(0); }

const BATCH = 200;
for (let i = 0; i < changes.length; i += BATCH) {
  const batch = db.batch();
  changes.slice(i, i + BATCH).forEach(c => batch.update(c.ref, c.update));
  await batch.commit();
  console.log(`커밋 ${Math.min(i + BATCH, changes.length)}/${changes.length}`);
}
console.log('완료');
process.exit(0);
```
`package.json` scripts에 추가:
```json
    "migrate:schoollevel": "node migrate-school-by-level.js",
    "migrate:schoollevel:run": "node migrate-school-by-level.js --run"
```

- [ ] **Step 2: dry-run + 표본 검증**
Run: `cd ~/projects/impact7DB && npm run migrate:schoollevel`
Expected: 학부별 필드 채움 + 활성 라벨 표본 출력(봉영여중1 등). 표본 육안 확인.

- [ ] **Step 3: 사용자 승인 후 실제 실행** (⚠️ 대량 배치 — [[feedback_no_autonomous_batch]])
dry-run 결과 보고 → 승인 후: `npm run migrate:schoollevel:run`

- [ ] **Step 4: 커밋**
```bash
git add migrate-school-by-level.js package.json
git commit -m "feat: 학부별 학교명 마이그레이션 + 활성 라벨 백필"
```
> 보류했던 `migrate-school-label.js`는 이 스크립트로 대체되므로 삭제(별도 커밋 또는 이 커밋에 포함).

---

## Self-Review (작성자 점검)

**Spec 커버리지:**
- 데이터 모델 school_elementary/middle/high → Task 4·6 ✓
- currentSchool 파생 + studentFullLabel currentSchool 기반 → Task 1 ✓
- 정규화(약어·지역명17·예외14) → Task 1 규칙·테스트 ✓
- school 미러 동기화(트리거) → Task 3 ✓
- 입력 UI(현재+접기) → Task 4 ✓
- 학년 승급 이전 학부 보존 → Task 5 ✓
- 마이그레이션 + 라벨 백필(활성만) → Task 6 ✓
- 전역 앱 전환·school 제거 = Phase 2(비목표) ✓

**미해결(구현 중):**
- DB 내부 `.school` 읽기(schoolShort 등 표시)는 미러 유지로 두므로 Phase 1 무변경. 단 openEditor 폼 로드에서 currentSchool 채우기(Task 4 Step 3 주석)는 currentSchool import 필요.
- 기존 16개 라벨 테스트를 학부별 입력으로 갱신 필요(Task 1 Step 3 주석) — 구현자가 반드시 반영.

**타입 일관성:** `SCHOOL_FIELD`(초등/중등/고등 → school_elementary/middle/high)가 Task 1·3·4·5·6 동일. `currentSchool(student)`·`studentFullLabel(student)`·`computeLabelUpdate(data)` 시그니처 일치 ✓.
