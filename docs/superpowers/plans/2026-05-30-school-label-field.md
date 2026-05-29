# 학교·학부·학년 라벨(school_level_grade) 필드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학생의 "봉영여중1" 같은 학교+학부+학년 라벨을 `@impact7/shared`의 단일 함수로 통일하고, Cloud Function 트리거로 `students.school_level_grade` 필드를 자동 동기화한다.

**Architecture:** `@impact7/shared`에 순수함수 `studentFullLabel` 추가(정규화+약어+학부+학년+졸업). `functions-shared` codebase의 `onDocumentWritten('students/{id}')` 트리거가 school/level/grade로 라벨을 합성해 `school_level_grade`에 저장(변경 시에만 write → 무한루프 방지). 기존 전체 학생은 백필 스크립트로 채운다.

**Tech Stack:** ESM 순수 JS(shared, `node --test`), Firebase Cloud Functions v2(`functions-shared`, vitest), Firestore admin SDK(백필).

**작업 순서(크로스앱):** Task 1(shared) → Task 2(shared 배포 v1.13.0) → Task 3(트리거) → Task 4(백필). shared가 GitHub 태그 의존이라 Task 2에서 v1.13.0 push해야 Task 3·4가 참조.

**범위:** 라벨 필드 생성·동기화 기반까지. 전역 앱(DB/exam/DSC)의 자체 조합 로직을 이 필드 읽기로 전환하는 **소비 전환은 후속 별도 계획**(필드가 채워진 뒤).

**⚠️ 버전 주의:** shared 현재 1.12.0. 이 작업은 **v1.13.0**. 시작 전 `cd ~/projects/impact7-shared && grep '"version"' package.json && git tag | grep v1.13` 로 점유 여부 확인(다른 작업이 선점했으면 다음 번호로 조정). [[feedback_shared_version_conflict]]

---

## 파일 구조

| 파일 | 책임 | 작업 |
|------|------|------|
| `~/projects/impact7-shared/student-label.js` | `studentFullLabel`·`normalizeRealLevelGrade` 순수함수(SSoT) | Create |
| `~/projects/impact7-shared/student-label.test.js` | 라벨 규칙 단위 테스트 | Create |
| `~/projects/impact7-shared/package.json` | export 등록 + v1.13.0 | Modify |
| `~/projects/impact7DB/functions-shared/index.js` | `onStudentLabelSync` 트리거 | Modify |
| `~/projects/impact7DB/functions-shared/package.json` | `@impact7/shared` 의존 추가 | Modify |
| `~/projects/impact7DB/functions-shared/test/student-label-sync.test.js` | 트리거 합성/스킵 로직 테스트 | Create |
| `~/projects/impact7DB/migrate-school-label.js` | 기존 학생 백필(dry-run 지원) | Create |

---

## Task 1: shared — `studentFullLabel` 순수함수 (TDD)

**Files:**
- Create: `~/projects/impact7-shared/student-label.js`
- Test: `~/projects/impact7-shared/student-label.test.js`

작업 디렉토리: `cd ~/projects/impact7-shared`

규칙 요약:
- 정규화: 접미사 `(초등학교|중학교|고등학교|학교)$` 제거 → 약어 치환(긴 것 우선) `사범대부속→사대부`, `여자→여`, `외국어→외`, `부속→부`.
- `normalizeRealLevelGrade`로 누적학년 보정 + 졸업 판정(고3 초과 → `졸업`).
- 졸업: `학교(졸업+N)` (학교 없으면 `졸업+N`).
- 그 외: `학교 + levelShort + grade`. **학교명이 levelShort로 끝나면 중복이므로 levelShort 생략**, 단 `윤중`·`운중`은 예외(유지).

- [ ] **Step 1: 실패 테스트 작성** — `student-label.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studentFullLabel, normalizeRealLevelGrade } from './student-label.js';

const S = (school, level, grade) => ({ school, level, grade });

test('풀네임 여자중학교 → 봉영여중1', () => {
  assert.equal(studentFullLabel(S('봉영여자중학교', '중등', 1)), '봉영여중1');
});
test('약어 봉영여중 → 봉영여중1 (학부글자 중복 제거)', () => {
  assert.equal(studentFullLabel(S('봉영여중', '중등', 1)), '봉영여중1');
});
test('예외 윤중중 → 윤중중1 (중복 제거 안 함)', () => {
  assert.equal(studentFullLabel(S('윤중중', '중등', 1)), '윤중중1');
});
test('예외 운중중 → 운중중2', () => {
  assert.equal(studentFullLabel(S('운중중', '중등', 2)), '운중중2');
});
test('초등학교 풀네임 → 양명초6', () => {
  assert.equal(studentFullLabel(S('양명초등학교', '초등', 6)), '양명초6');
});
test('초 약어 → 양명초6 (초초 중복 제거)', () => {
  assert.equal(studentFullLabel(S('양명초', '초등', 6)), '양명초6');
});
test('외국어 → 외: 이화외고2', () => {
  assert.equal(studentFullLabel(S('이화외국어고등학교', '고등', 2)), '이화외고2');
});
test('부속 → 부: 이대부고1', () => {
  assert.equal(studentFullLabel(S('이대부속고등학교', '고등', 1)), '이대부고1');
});
test('사범대부속 → 사대부 (긴 것 우선)', () => {
  assert.equal(studentFullLabel(S('서울사범대부속고등학교', '고등', 1)), '서울사대부고1');
});
test('졸업: 고등 grade 4 → 누적 13 → (졸업+1)', () => {
  assert.equal(studentFullLabel(S('한국고등학교', '고등', 4)), '한국고(졸업+1)');
});
test('누적 학년 보정: 초등 grade 11 → 고2', () => {
  assert.equal(studentFullLabel(S('한국고등학교', '초등', 11)), '한국고2');
});
test('학년 없음 → 학교+학부', () => {
  assert.equal(studentFullLabel(S('양명초등학교', '초등', 0)), '양명초');
});
test('school 빈 값 → 학부+학년만', () => {
  assert.equal(studentFullLabel(S('', '중등', 1)), '중1');
});

test('normalizeRealLevelGrade: 졸업 판정', () => {
  assert.deepEqual(normalizeRealLevelGrade({ level: '고등', grade: 4 }), { level: '졸업', grade: 1, graduated: true });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ~/projects/impact7-shared && node --test student-label.test.js`
Expected: FAIL — `Cannot find module './student-label.js'`

- [ ] **Step 3: 구현 작성** — `student-label.js`

```js
// 학생의 학교+학부+학년 라벨("봉영여중1") 단일 소스. 순수 함수.
const LEVEL_CUMULATIVE_START = { '초등': 0, '중등': 6, '고등': 9 };
const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고', '졸업': '졸업' };
// 긴 패턴 우선(사범대부속이 부속보다 먼저). 한국 학교명 약어.
const SCHOOL_ABBR = [['사범대부속', '사대부'], ['여자', '여'], ['외국어', '외'], ['부속', '부']];
// 학교명 자체가 학부글자로 끝나 levelShort 생략 대상이 아닌 예외(윤중/운중).
const DUP_EXCEPT = new Set(['윤중', '운중']);

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
  return s;
}

export function studentFullLabel(student) {
  const norm = normalizeRealLevelGrade(student || {});
  const school = normalizeSchoolForLabel(student?.school);
  const lv = LEVEL_SHORT[norm.level] || '';
  if (norm.graduated) return school ? `${school}(졸업+${norm.grade})` : `졸업+${norm.grade}`;
  const dup = lv && school.endsWith(lv) && !DUP_EXCEPT.has(school);
  const lvPart = dup ? '' : lv;
  const gradePart = norm.grade ? String(norm.grade) : '';
  return `${school}${lvPart}${gradePart}`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd ~/projects/impact7-shared && node --test student-label.test.js`
Expected: PASS — 14 tests

- [ ] **Step 5: package.json export 등록 + 버전 + 커밋**

`exports`에 `"./student-label": "./student-label.js"` 추가, `files`에 `"student-label.js"` 추가, `version` → `1.13.0`.

```bash
cd ~/projects/impact7-shared
git add student-label.js student-label.test.js package.json
git commit -m "feat: studentFullLabel — 학교+학부+학년 라벨 단일소스 (약어·중복·졸업) v1.13.0"
```

---

## Task 2: shared 배포 (v1.13.0 태그)

**Files:** 없음 (배포)

- [ ] **Step 1: 전체 테스트**

Run: `cd ~/projects/impact7-shared && node --test`
Expected: PASS — 기존 + student-label 14건 모두 통과

- [ ] **Step 2: 태그 + 푸시** (⚠️ 외부 배포 — 비가역)

```bash
cd ~/projects/impact7-shared
git tag v1.13.0
git push origin main && git push origin v1.13.0
```
Expected: `v1.13.0` 태그가 origin에 푸시됨. (실행 전 controller가 사용자 확인)

---

## Task 3: functions-shared — `onStudentLabelSync` 트리거

**Files:**
- Modify: `~/projects/impact7DB/functions-shared/package.json` (의존 추가)
- Modify: `~/projects/impact7DB/functions-shared/index.js` (트리거 추가)
- Test: `~/projects/impact7DB/functions-shared/test/student-label-sync.test.js`

작업 디렉토리: `cd ~/projects/impact7DB/functions-shared`

- [ ] **Step 1: shared 의존 추가 + 설치**

`package.json`의 `dependencies`에 추가:
```json
    "@impact7/shared": "github:chief-impact7/impact7-shared#v1.13.0",
```
Run:
```bash
cd ~/projects/impact7DB/functions-shared
npm install @impact7/shared@github:chief-impact7/impact7-shared#v1.13.0
node -e "import('@impact7/shared/student-label').then(m => console.log(typeof m.studentFullLabel))"
```
Expected: `function`. (`readlink node_modules/@impact7/shared`로 심볼릭 링크 아닌 실제 디렉토리 확인 — [[feedback_shared_version_conflict]])

- [ ] **Step 2: 트리거 로직 단위 테스트 작성** — `test/student-label-sync.test.js`

순수 동기화 판정(`computeLabelUpdate`)을 분리해 테스트한다(트리거 핸들러는 emulator 없이 못 돌리므로 로직만).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLabelUpdate } from '../src/studentLabelSync.js';

test('라벨이 바뀌면 update 반환', () => {
  const r = computeLabelUpdate({ school: '봉영여자중학교', level: '중등', grade: 1, school_level_grade: '구값' });
  assert.deepEqual(r, { school_level_grade: '봉영여중1' });
});
test('라벨이 같으면 null (무한루프 방지)', () => {
  const r = computeLabelUpdate({ school: '봉영여중', level: '중등', grade: 1, school_level_grade: '봉영여중1' });
  assert.equal(r, null);
});
```
> functions-shared는 `npm test`가 `vitest`지만, 위 파일은 `node:test`로 작성해 `node --test test/student-label-sync.test.js`로 실행한다(vitest도 node:test 호환). 

- [ ] **Step 3: 동기화 로직 분리 모듈 작성** — `src/studentLabelSync.js`

```js
import { studentFullLabel } from '@impact7/shared/student-label';

// 변경 후 문서 데이터 → 갱신할 필드(또는 변경 없으면 null).
export function computeLabelUpdate(data) {
  const label = studentFullLabel(data);
  if (data?.school_level_grade === label) return null;
  return { school_level_grade: label };
}
```

- [ ] **Step 4: 트리거 핸들러 추가** — `index.js` 끝에 추가 (기존 `onAttendance`(index.js:42) 패턴 따름)

import 추가(파일 상단 import 블록):
```js
import { computeLabelUpdate } from './src/studentLabelSync.js';
```
export 추가(파일 끝):
```js
// students 쓰기 시 school/level/grade로 school_level_grade 라벨 자동 동기화.
// 어떤 경로(편집·승급·import·진단평가)로 쓰이든 발화 → stale 차단.
export const onStudentLabelSync = onDocumentWritten(
  { document: 'students/{docId}' },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return null; // 삭제는 무시
    const update = computeLabelUpdate(after.data());
    if (!update) return null; // 라벨 동일 → write 스킵(무한루프 방지)
    await after.ref.update(update);
    return null;
  }
);
```

- [ ] **Step 5: 테스트 통과 + 커밋**

Run: `cd ~/projects/impact7DB/functions-shared && node --test test/student-label-sync.test.js`
Expected: PASS — 2 tests

```bash
cd ~/projects/impact7DB/functions-shared
git add package.json package-lock.json index.js src/studentLabelSync.js test/student-label-sync.test.js
git commit -m "feat: onStudentLabelSync 트리거 — school_level_grade 자동 동기화 (@impact7/shared v1.13.0)"
```

- [ ] **Step 6: 배포** (⚠️ shared codebase만 — leave-request 건드리지 않음, AGENTS 규칙)

Run: `cd ~/projects/impact7DB && firebase deploy --only functions:shared --project impact7db`
Expected: `onStudentLabelSync` 배포 성공. (실행 전 controller가 사용자 확인)

---

## Task 4: 마이그레이션 백필

**Files:**
- Create: `~/projects/impact7DB/migrate-school-label.js`

작업 디렉토리: `cd ~/projects/impact7DB`

- [ ] **Step 1: 백필 스크립트 작성** — `migrate-school-label.js`

기존 `dedup-students.js`/`check-duplicates.js`의 admin SDK 초기화 패턴을 따른다(`--env-file=.env`). `--run` 없으면 dry-run.

```js
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { studentFullLabel } from '@impact7/shared/student-label';
import { readFileSync } from 'node:fs';

const sa = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const RUN = process.argv.includes('--run');

const snap = await db.collection('students').get();
const changes = [];
snap.forEach(d => {
  const data = d.data();
  const label = studentFullLabel(data);
  if (data.school_level_grade !== label) changes.push({ id: d.id, from: data.school_level_grade || '—', to: label });
});

console.log(`대상 ${changes.length}/${snap.size}건`);
changes.slice(0, 20).forEach(c => console.log(`  ${c.id}: ${c.from} → ${c.to}`));
if (changes.length > 20) console.log(`  ... 외 ${changes.length - 20}건`);

if (!RUN) { console.log('\n[dry-run] --run 으로 실제 반영'); process.exit(0); }

const BATCH = 200;
for (let i = 0; i < changes.length; i += BATCH) {
  const batch = db.batch();
  changes.slice(i, i + BATCH).forEach(c => batch.update(db.doc(`students/${c.id}`), { school_level_grade: c.to }));
  await batch.commit();
  console.log(`커밋 ${Math.min(i + BATCH, changes.length)}/${changes.length}`);
}
console.log('완료');
```

`package.json` scripts에 추가:
```json
    "migrate:label": "node --env-file=.env migrate-school-label.js",
    "migrate:label:run": "node --env-file=.env migrate-school-label.js --run"
```

- [ ] **Step 2: dry-run 실행 + 표본 검증**

Run: `cd ~/projects/impact7DB && npm run migrate:label`
Expected: 대상 건수 + 변환 표본 출력. 표본이 규칙대로인지 육안 확인(봉영여중1 등).

- [ ] **Step 3: 사용자 승인 후 실제 백필** (⚠️ 대량 배치 — [[feedback_no_autonomous_batch]])

dry-run 결과를 사용자에게 보고하고 **명시 승인** 받은 뒤:
Run: `cd ~/projects/impact7DB && npm run migrate:label:run`
Expected: 200건 청크로 전체 커밋 완료.

- [ ] **Step 4: 커밋**

```bash
cd ~/projects/impact7DB
git add package.json migrate-school-label.js
git commit -m "feat: school_level_grade 백필 스크립트"
```
> `migrate-school-label.js`는 `@impact7/shared/student-label`을 import하므로, 실행 전 DB가 v1.13.0을 설치해야 한다: `npm install @impact7/shared@github:chief-impact7/impact7-shared#v1.13.0` (별도 커밋 또는 이 커밋에 package.json 포함).

---

## Self-Review (작성자 점검)

**Spec 커버리지** (design 대비):
- 공유 함수 SSoT → Task 1 (`studentFullLabel` @impact7/shared) ✓
- 저장 필드 `school_level_grade` → Task 3·4 ✓
- Cloud Function 트리거 동기화(경로 무관) → Task 3 ✓
- 무한루프 방지 → Task 3 `computeLabelUpdate` 동일값 null ✓
- 마이그레이션 백필 + 사용자 승인 → Task 4 ✓
- 약어 4개·중복제거·윤중/운중 예외·졸업 → Task 1 규칙·테스트 ✓
- 전역 앱 소비 전환 = 후속(비목표) — 계획 범위 밖 명시 ✓

**미해결(구현 중 확인):**
- `normalizeRealLevelGrade`가 DB `promo-extractor-core.js`에도 있음(복제). 1차는 shared 자체완결, **DB 통합은 후속**(순수 결정적이라 동작 동일).
- DB가 백필 실행하려면 shared v1.13.0 설치 필요(Task 4 Step 4 주석).

**타입 일관성:** `studentFullLabel(student)`·`normalizeRealLevelGrade(s)`·`computeLabelUpdate(data)` 시그니처가 Task 1·3에서 일치 ✓. 필드명 `school_level_grade` 전 Task 동일 ✓.
