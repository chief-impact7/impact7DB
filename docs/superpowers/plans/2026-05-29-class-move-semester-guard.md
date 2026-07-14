# 반 이동 안전화(학기 컨텍스트 가드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 DB 일괄 반 변경을 학기 컨텍스트 가드로 안전화하고, 반 이동 순수 로직을 `@impact7/shared`로 공유화해 내신 숨김·합반 누락을 해소한다.

**Architecture:** 반 이동 변환을 `@impact7/shared`의 순수 함수 `moveClass`로 추출(테스트 가능). DB `applyBulkClass`는 학기 OFF면 차단하는 가드를 두고, 각 학생을 `moveClass`로 변환한 뒤 충돌 검사·누락/경고 보고·배치 쓰기를 담당한다.

**Tech Stack:** Vanilla JS (ESM), Vite, Firebase/Firestore, Node 내장 테스트 러너(`node --test`), `@impact7/shared`(GitHub repo, semver 태그 배포).

**Scope:** shared + impact7DB만. DSC는 후속 별도 계획(DSC엔 일괄 반 변경 UI가 없어 신설이 필요).

**작업 repo 2개:**
- `/Users/jongsooyi/IMPACT7/impact7-shared` (공유 로직, 태그 배포)
- `/Users/jongsooyi/IMPACT7/impact7DB` (현재 브랜치 `feat/class-move-semester-guard`)

---

## Task 1: shared — `moveClass` 순수 함수 (TDD)

**Files:**
- Create: `/Users/jongsooyi/IMPACT7/impact7-shared/class-move.js`
- Test: `/Users/jongsooyi/IMPACT7/impact7-shared/class-move.test.js`

설계 메모:
- 대상 = `student.enrollments` 중 `(class_type==='정규' 또는 미지정) && semester===대상학기` 첫 항목.
- 없으면 `skipped:true`, 원본 enrollments 그대로 반환.
- 있으면 `level_symbol`/`class_number`만 교체(in-place 사상), `day`·`start_date`·`semester`·`naesin_class_override` 보존.
- 경고: `naesin_class_override`가 비어있는(자동매핑 의존) 정규인데 반번호 끝자리 홀짝(A/B)이 바뀌면 `warning` 문자열.

- [ ] **Step 1: 실패 테스트 작성** — `class-move.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveClass } from './class-move.js';

const student = (enrollments, name = '홍길동') => ({ name, enrollments });

test('정상: 해당 학기 정규를 새 반으로 in-place 이동', () => {
  const s = student([{ class_type: '정규', level_symbol: 'HX', class_number: '106', semester: '2026-Spring', day: ['월'], start_date: '2026-03-02' }]);
  const r = moveClass(s, { semester: '2026-Spring', targetLevelSymbol: 'HX', targetClassNumber: '108' });
  assert.equal(r.skipped, false);
  assert.equal(r.before, 'HX106');
  assert.equal(r.after, 'HX108');
  assert.equal(r.updatedEnrollments[0].class_number, '108');
  assert.deepEqual(r.updatedEnrollments[0].day, ['월']);
  assert.equal(r.updatedEnrollments[0].start_date, '2026-03-02');
});

test('skipped: 해당 학기 정규 enrollment 없음 → 원본 불변', () => {
  const s = student([{ class_type: '정규', level_symbol: 'HX', class_number: '106', semester: '2026-Winter' }]);
  const r = moveClass(s, { semester: '2026-Spring', targetLevelSymbol: 'HX', targetClassNumber: '108' });
  assert.equal(r.skipped, true);
  assert.equal(r.updatedEnrollments[0].class_number, '106');
});

test('override 보존 + 경고 없음', () => {
  const s = student([{ class_type: '정규', level_symbol: 'HX', class_number: '106', semester: '2026-Spring', naesin_class_override: '2단지강서고1A' }]);
  const r = moveClass(s, { semester: '2026-Spring', targetLevelSymbol: 'HX', targetClassNumber: '107' });
  assert.equal(r.updatedEnrollments[0].naesin_class_override, '2단지강서고1A');
  assert.equal(r.warning, null);
});

test('A/B 경고: override 없고 끝자리 홀짝 바뀜(106→107)', () => {
  const s = student([{ class_type: '정규', level_symbol: 'HX', class_number: '106', semester: '2026-Spring' }]);
  const r = moveClass(s, { semester: '2026-Spring', targetLevelSymbol: 'HX', targetClassNumber: '107' });
  assert.ok(r.warning);
});

test('경고 없음: 끝자리 홀짝 동일(106→108)', () => {
  const s = student([{ class_type: '정규', level_symbol: 'HX', class_number: '106', semester: '2026-Spring' }]);
  const r = moveClass(s, { semester: '2026-Spring', targetLevelSymbol: 'HX', targetClassNumber: '108' });
  assert.equal(r.warning, null);
});

test('특강 enrollment는 대상 아님 (정규만 이동)', () => {
  const s = student([
    { class_type: '특강', level_symbol: 'HX', class_number: '900', semester: '2026-Spring' },
    { class_type: '정규', level_symbol: 'HX', class_number: '106', semester: '2026-Spring' },
  ]);
  const r = moveClass(s, { semester: '2026-Spring', targetLevelSymbol: 'HX', targetClassNumber: '108' });
  assert.equal(r.updatedEnrollments[0].class_number, '900');
  assert.equal(r.updatedEnrollments[1].class_number, '108');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7-shared && node --test class-move.test.js`
Expected: FAIL — `Cannot find module './class-move.js'`

- [ ] **Step 3: 최소 구현 작성** — `class-move.js`

```js
// 학생 1명의 특정 학기 정규 enrollment를 다른 반으로 in-place 이동한다 (순수 함수).
// override·start_date·day·semester는 보존. 대상 정규가 없으면 skipped.

const codeOf = (e) => `${e.level_symbol || ''}${e.class_number || ''}`;
const isRegular = (e) => (e.class_type || '정규') === '정규';
const lastDigit = (n) => {
  const m = String(n ?? '').match(/(\d)\D*$/);
  return m ? Number(m[1]) : null;
};

export function moveClass(student, { semester, targetLevelSymbol, targetClassNumber }) {
  const enrollments = student.enrollments || [];
  const idx = enrollments.findIndex((e) => isRegular(e) && e.semester === semester);
  if (idx < 0) {
    return { updatedEnrollments: enrollments, before: null, after: null, skipped: true, warning: null };
  }
  const target = enrollments[idx];
  const before = codeOf(target);
  const after = `${targetLevelSymbol}${targetClassNumber}`;
  const updatedEnrollments = enrollments.map((e, i) =>
    i === idx ? { ...e, level_symbol: targetLevelSymbol, class_number: targetClassNumber } : e
  );

  let warning = null;
  const hasOverride =
    typeof target.naesin_class_override === 'string' && target.naesin_class_override !== '';
  const oldP = lastDigit(target.class_number);
  const newP = lastDigit(targetClassNumber);
  if (!hasOverride && oldP != null && newP != null && oldP % 2 !== newP % 2) {
    warning = `${student.name || ''}: 반번호 끝자리 홀짝(A/B)이 바뀌어 내신 자동매핑이 달라질 수 있음`;
  }

  return { updatedEnrollments, before, after, skipped: false, warning };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7-shared && node --test class-move.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: 커밋**

```bash
cd /Users/jongsooyi/IMPACT7/impact7-shared
git add class-move.js class-move.test.js
git commit -m "feat: moveClass — 특정 학기 정규 enrollment in-place 반 이동 순수함수"
```

---

## Task 2: shared — export 등록 + 버전 태그 배포

**Files:**
- Modify: `/Users/jongsooyi/IMPACT7/impact7-shared/package.json`

- [ ] **Step 1: package.json 수정** — `exports`·`files`에 class-move 추가, `version` → `1.11.0`

`exports` 블록에 한 줄 추가:
```json
    "./enrollment-derivation": "./enrollment-derivation.js",
    "./class-move": "./class-move.js",
    "./promote-enroll": "./promote-enroll.js",
```

`files` 배열에 한 줄 추가:
```json
    "enrollment-derivation.js",
    "class-move.js",
    "promote-enroll.js",
```

`version` 변경:
```json
  "version": "1.11.0",
```

- [ ] **Step 2: 전체 테스트 실행**

Run: `cd /Users/jongsooyi/IMPACT7/impact7-shared && node --test`
Expected: PASS — 기존 테스트 + class-move 6건 모두 통과

- [ ] **Step 3: 커밋 + 태그 + 푸시**

```bash
cd /Users/jongsooyi/IMPACT7/impact7-shared
git add package.json
git commit -m "chore: class-move export 등록, v1.11.0"
git tag v1.11.0
git push && git push --tags
```
Expected: 태그 `v1.11.0`가 origin에 푸시됨

---

## Task 3: DB — 의존성 v1.11.0으로 갱신

**Files:**
- Modify: `/Users/jongsooyi/IMPACT7/impact7DB/package.json:?` (`@impact7/shared` 줄)

- [ ] **Step 1: package.json의 shared 버전 갱신**

`"@impact7/shared": "github:chief-impact7/impact7-shared#v1.10.0"` →
```json
    "@impact7/shared": "github:chief-impact7/impact7-shared#v1.11.0",
```

- [ ] **Step 2: 재설치 + export 확인**

Run:
```bash
cd /Users/jongsooyi/IMPACT7/impact7DB && npm install
node -e "import('@impact7/shared/class-move').then(m => console.log(typeof m.moveClass))"
```
Expected: `function`

- [ ] **Step 3: 커밋**

```bash
cd /Users/jongsooyi/IMPACT7/impact7DB
git add package.json package-lock.json
git commit -m "chore: @impact7/shared v1.11.0 (moveClass)"
```

---

## Task 4: DB — `applyBulkClass`에 학기 가드 + moveClass 적용

**Files:**
- Modify: `/Users/jongsooyi/IMPACT7/impact7DB/app.js` (상단 import 영역, `applyBulkClass` 함수 `app.js:4589-4664`)

현재 `applyBulkClass`는 학기 OFF면 `enrollments[0]`을 건드리고(4612), `semester` 없는 학생을 조용히 skip하며(4613), 충돌 검사가 없다. 아래로 교체한다.

- [ ] **Step 1: import 추가** (app.js 기존 `@impact7/shared` import 근처)

기존 파일 상단의 import들 사이에 추가:
```js
import { moveClass } from '@impact7/shared/class-move';
```

- [ ] **Step 2: `applyBulkClass` 본문 교체** (`app.js:4589-4664`)

`window.applyBulkClass = async () => { ... };` 전체를 아래로 교체:
```js
window.applyBulkClass = async () => {
    if (isPastSemester()) { alert('과거 학기는 수정할 수 없습니다.'); return; }
    const raw = document.getElementById('bulk-class-code').value.trim().toUpperCase();
    if (!raw) { alert('반코드를 입력해주세요. (예: HX103)'); return; }
    if (selectedStudentIds.size === 0) { alert('학생을 선택해주세요.'); return; }

    // 학기 컨텍스트 가드: 어느 학기 수업을 옮길지 확정돼야 안전하게 이동 가능
    const sem = activeFilters.semester;
    if (!sem) {
        alert('어느 학기 수업을 옮길지 먼저 좌측 Semester에서 학기를 선택하세요.');
        return;
    }

    const match = raw.match(/^([A-Za-z]+)(\d+)$/);
    if (!match) { alert('반코드 형식이 올바르지 않습니다. (예: HX103, HA201)'); return; }
    const levelSymbol = match[1];
    const classNumber = match[2];

    if (!confirm(`선택한 ${selectedStudentIds.size}명의 ${sem} 정규반을 '${raw}'(으)로 변경합니다.`)) return;

    const ids = [...selectedStudentIds];
    try {
        const changes = [];
        const updateMap = {};
        const skipped = [];
        const warnings = [];

        ids.forEach(id => {
            const student = allStudents.find(s => s.id === id);
            if (!student) return;
            const { updatedEnrollments, before, after, skipped: sk, warning } = moveClass(student, {
                semester: sem, targetLevelSymbol: levelSymbol, targetClassNumber: classNumber,
            });
            if (sk) { skipped.push(student.name || id); return; }
            if (findEnrollmentConflicts(updatedEnrollments).length) {
                skipped.push(`${student.name || id} (반명 충돌)`);
                return;
            }
            if (warning) warnings.push(warning);

            const newBranch = branchFromClassNumber(classNumber);
            const updateData = { enrollments: updatedEnrollments };
            if (newBranch) updateData.branch = newBranch;
            updateMap[id] = updateData;
            changes.push({ id, name: student.name, from: before, to: after, enrollments: updatedEnrollments });
        });

        if (changes.length === 0) {
            alert(`변경할 학생이 없습니다.\n${skipped.length ? '제외: ' + skipped.join(', ') : ''}`);
            return;
        }

        const BATCH_SIZE = 200;
        for (let i = 0; i < changes.length; i += BATCH_SIZE) {
            const chunk = changes.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);
            chunk.forEach(c => {
                batch.update(doc(db, 'students', c.id), updateMap[c.id]);
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: c.id, change_type: 'UPDATE',
                    before: `반: ${c.from}`, after: `반: ${c.to} (일괄변경)`,
                    google_login_id: currentUser?.email || '—', timestamp: serverTimestamp()
                });
            });
            await batch.commit();
        }

        changes.forEach(c => {
            const s = allStudents.find(s => s.id === c.id);
            if (s) {
                s.enrollments = c.enrollments;
                const newBranch = branchFromClassNumber(classNumber);
                if (newBranch) s.branch = newBranch;
            }
        });

        document.getElementById('bulk-class-code').value = '';
        buildClassFilterSidebar();
        applyFilterAndRender();
        updateBulkEditSummary();
        let msg = `${changes.length}명의 반을 '${raw}'(으)로 변경했습니다. (${sem} 정규)`;
        if (skipped.length) msg += `\n\n⚠️ 제외 ${skipped.length}명: ${skipped.join(', ')}\n(해당 학기 정규 수업이 없거나 반명 충돌)`;
        if (warnings.length) msg += `\n\n⚠️ 내신 매핑 주의:\n${warnings.join('\n')}`;
        alert(msg);
    } catch (e) {
        console.error('[BULK CLASS ERROR]', e);
        alert('일괄 반 변경 실패: ' + e.message);
    }
};
```

- [ ] **Step 3: 빌드 확인**

Run: `cd /Users/jongsooyi/IMPACT7/impact7DB && npx vite build`
Expected: 빌드 성공, 신규 에러 없음 (기존 chunk-size 경고는 무방)

- [ ] **Step 4: 수동 검증 (dev 서버)**

Run: `cd /Users/jongsooyi/IMPACT7/impact7DB && npm run dev` 후 브라우저에서:
1. 좌측 Semester에서 대상 학부 학기 선택(ON) → 내신 학생이 원래 반 그룹에 나타나는지 확인
2. 벌크 모드 → 내신 학생 포함 다수 선택 → 일괄 반 변경에 `HX108` 입력
3. 변경 후: 정규 class_number만 바뀌고 `naesin_class_override`·`start_date` 유지 확인 (학생 상세/Firestore)
4. 학기 OFF 상태에서 일괄 반 변경 시도 → "학기를 선택하세요" 차단 확인
5. `semester` 없는 학생 포함 시 "제외 N명" 보고 확인

Expected: 위 5개 모두 기대대로 동작

- [ ] **Step 5: simplify → review** (AGENTS.md 규칙: 소스 수정 커밋 전 필수)

Run: `/simplify` 후 `/code-review` (app.js 변경분 대상). 결과 반영.

- [ ] **Step 6: 커밋**

```bash
cd /Users/jongsooyi/IMPACT7/impact7DB
git add app.js
git commit -m "feat: 일괄 반 변경에 학기 컨텍스트 가드 + moveClass 적용

- 학기 OFF면 차단(enrollments[0] 무방비 폴백 제거)
- moveClass로 해당 학기 정규를 in-place 이동(override·이력 보존)
- semester 미기재/충돌 학생 누락 보고, A/B 경고"
```

---

## Self-Review (작성자 점검 결과)

**Spec 커버리지** (design doc 5장 대비):
- 5.1 학기 가드 → Task 4 Step 2 (가드 + 폴백 제거) ✓
- 5.2 누락 보고 → Task 4 Step 2 (`skipped` 명단 alert) ✓
- 5.3 A/B 경고 → Task 1 `warning` + Task 4 보고 ✓
- 5.4 충돌 검사 → Task 4 `findEnrollmentConflicts` ✓
- 5.5 공유화 → Task 1~3 (`moveClass` in shared) ✓
- 합반 누락 방지(2장/6장) → 코드 변경 불필요: 학기 ON 시 `relevantEnrollments`가 raw로 전환되어 내신 학생이 반 그룹에 복원됨(app.js:321 기존 동작). 가드가 학기 ON을 강제하므로 자동 충족 ✓

**비목표 확인:** DSC·전용 UI·단건 진입 버튼·특강 이동 — 계획에 없음 ✓

**타입 일관성:** `moveClass` 반환 `{updatedEnrollments, before, after, skipped, warning}` — Task 1 정의와 Task 4 구조분해 일치 ✓

**잔여 리스크(문서화):** 합반 누락 방지는 "학기 ON 시 기존 `relevantEnrollments` 동작"에 의존한다. 학기 ON에서도 반 그룹에 내신 학생이 안 나타나면 별도 조사 필요(현 코드 분석상으론 나타남).
