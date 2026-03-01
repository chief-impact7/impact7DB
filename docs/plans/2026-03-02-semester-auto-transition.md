# 학기별 자동 반이동 구현 계획

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 같은 class_type의 새 학기 enrollment start_date가 도래하면, 이전 학기 enrollment을 자동 비활성화하여 학생이 1개 반만 다니는 것처럼 표시

**Architecture:** app.js에 `getActiveEnrollments(student)` 유틸리티를 추가하고, 목록/필터/그룹뷰/통계에서 이 함수를 사용. 학기 필터 적용 시에는 기존 로직 유지. 상세화면에서는 활성+비활성 모두 표시하되 비활성은 이력으로 구분.

**Tech Stack:** Vanilla JS (app.js), Firebase Firestore (DB 변경 없음)

---

### Task 1: `getActiveEnrollments()` 유틸리티 함수 추가

**Files:**
- Modify: `app.js:73-101` (헬퍼 함수 영역)

**Step 1: 함수 작성**

`app.js`의 기존 헬퍼 함수들 바로 아래(line 101 이후)에 추가:

```javascript
/**
 * 활성 enrollment만 반환.
 * 같은 class_type 내에서 start_date <= 오늘인 것 중 가장 최근 것만 활성.
 * start_date > 오늘이면 "예정" (비활성).
 * 같은 class_type의 새 enrollment이 없으면 이전 것이 계속 활성.
 */
const getActiveEnrollments = (s) => {
    const enrollments = s.enrollments || [];
    if (enrollments.length === 0) return [];

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const byType = {};

    for (const e of enrollments) {
        const ct = e.class_type || '정규';
        if (!byType[ct]) byType[ct] = [];
        byType[ct].push(e);
    }

    const active = [];
    for (const [ct, list] of Object.entries(byType)) {
        // start_date <= 오늘인 것 중 가장 최근
        const started = list
            .filter(e => !e.start_date || e.start_date <= today)
            .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));

        if (started.length > 0) {
            active.push(started[0]);
        } else {
            // 모두 미래이면 → 가장 이른 것 (예정)
            const sorted = [...list].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
            active.push(sorted[0]);
        }
    }
    return active;
};
```

**Step 2: 브라우저 콘솔에서 수동 검증**

`npm run dev` 실행 후 콘솔에서:
```javascript
// 임승찬 데이터로 테스트
const s = allStudents.find(s => s.name === '임승찬');
console.log('전체:', s.enrollments);
console.log('활성:', getActiveEnrollments(s));
// 예상: 전체 3개, 활성 1~2개 (오늘 날짜 기준)
```

**Step 3: 커밋**

```bash
git add app.js
git commit -m "feat: add getActiveEnrollments() utility for semester auto-transition"
```

---

### Task 2: 활성 enrollment 기반 헬퍼 함수 추가

**Files:**
- Modify: `app.js:76` (`allClassCodes`)
- Modify: `app.js:90-98` (`branchesFromStudent`)
- Modify: `app.js:101` (`combinedDays`)

**Step 1: 활성 enrollment 기반 헬퍼 함수 추가**

기존 함수는 그대로 두고 (학기 필터/상세화면/편집에서 필요), 활성 버전을 추가:

```javascript
const activeClassCodes = (s) => getActiveEnrollments(s).map(e => enrollmentCode(e)).filter(Boolean);

const activeBranchesFromStudent = (s) => {
    const set = new Set();
    getActiveEnrollments(s).forEach(e => {
        const b = branchFromClassNumber(e.class_number);
        if (b) set.add(b);
    });
    if (set.size === 0 && s.branch) set.add(s.branch);
    return [...set];
};

const activeDays = (s) => [...new Set(getActiveEnrollments(s).flatMap(e => normalizeDays(e.day)))];
```

**Step 2: 커밋**

```bash
git add app.js
git commit -m "feat: add active-enrollment-based helper functions"
```

---

### Task 3: 학생 목록 렌더링에서 활성 enrollment 사용

**Files:**
- Modify: `app.js:719-794` (`renderStudentItem`)

**Step 1: `renderStudentItem()` 수정**

학기 필터가 없을 때만 활성 enrollment 기반으로 표시:

```javascript
// line 723 변경:
// 기존: const branch = branchesFromStudent(s).join(', ') || branchFromStudent(s);
// 변경:
const branch = activeFilters.semester
    ? branchesFromStudent(s).join(', ') || branchFromStudent(s)
    : activeBranchesFromStudent(s).join(', ') || branchFromStudent(s);

// line 726 변경:
// 기존: const tags = allClassCodes(s).map(...)
// 변경:
const codes = activeFilters.semester ? allClassCodes(s) : activeClassCodes(s);
const tags = codes.map(c => `<span class="item-tag">${esc(c)}</span>`).join('') || '<span class="item-tag">—</span>';

// line 732 변경:
// 기존: const days = combinedDays(s);
// 변경:
const days = activeFilters.semester ? combinedDays(s) : activeDays(s);
```

**Step 2: 브라우저에서 검증**

- 학기 필터 없음: 임승찬이 활성 반(AX103)만 표시되는지 확인
- 2026winter 필터: 겨울 반(A101, HX) 모두 표시되는지 확인
- 2026-Spring 필터: 봄 반만 표시되는지 확인

**Step 3: 커밋**

```bash
git add app.js
git commit -m "feat: show only active enrollments in student list (no semester filter)"
```

---

### Task 4: 필터링 로직에서 활성 enrollment 사용

**Files:**
- Modify: `app.js:550-577` (`applyFilterAndRender`)

**Step 1: 학기 필터 없을 때 활성 enrollment 기반 필터링**

```javascript
// line 572 변경 (branch 필터):
// 기존: if (activeFilters.branch) filtered = filtered.filter(s => branchesFromStudent(s).includes(activeFilters.branch));
// 변경:
if (activeFilters.branch) {
    filtered = activeFilters.semester
        ? filtered.filter(s => branchesFromStudent(s).includes(activeFilters.branch))
        : filtered.filter(s => activeBranchesFromStudent(s).includes(activeFilters.branch));
}

// line 573 변경 (day 필터):
// 기존: if (activeFilters.day) filtered = filtered.filter(s => combinedDays(s).includes(activeFilters.day));
// 변경:
if (activeFilters.day) {
    filtered = activeFilters.semester
        ? filtered.filter(s => combinedDays(s).includes(activeFilters.day))
        : filtered.filter(s => activeDays(s).includes(activeFilters.day));
}

// line 575 변경 (class_type 필터):
// 기존: if (activeFilters.class_type) filtered = filtered.filter(s => (s.enrollments || []).some(e => e.class_type === activeFilters.class_type));
// 변경:
if (activeFilters.class_type) {
    const enrollFn = activeFilters.semester
        ? (s) => (s.enrollments || [])
        : (s) => getActiveEnrollments(s);
    filtered = filtered.filter(s => enrollFn(s).some(e => e.class_type === activeFilters.class_type));
}

// line 576 변경 (class_code 필터):
// 기존: if (activeFilters.class_code) filtered = filtered.filter(s => allClassCodes(s).includes(activeFilters.class_code));
// 변경:
if (activeFilters.class_code) {
    filtered = activeFilters.semester
        ? filtered.filter(s => allClassCodes(s).includes(activeFilters.class_code))
        : filtered.filter(s => activeClassCodes(s).includes(activeFilters.class_code));
}
```

**Step 2: 검증**

- 학기 필터 없음 + branch 필터 "2단지": 활성 enrollment 기준 분류 확인
- 학기 필터 없음 + class_code 필터: 활성 반 코드만 매칭되는지 확인

**Step 3: 커밋**

```bash
git add app.js
git commit -m "feat: filter by active enrollments when no semester filter"
```

---

### Task 5: 사이드바 반 목록에서 활성 enrollment 사용

**Files:**
- Modify: `app.js:494-545` (`buildClassFilterSidebar`)

**Step 1: 학기 필터 없을 때 활성 enrollment 기반 반 목록**

```javascript
// lines 508-514 변경:
// 기존:
// const enrollments = semFilter
//     ? (s.enrollments || []).filter(e => e.semester === semFilter)
//     : (s.enrollments || []);
// 변경:
const enrollments = semFilter
    ? (s.enrollments || []).filter(e => e.semester === semFilter)
    : getActiveEnrollments(s);
```

**Step 2: 검증**

- 학기 필터 없음: 사이드바에 활성 반 코드만 표시되는지 확인
- 학기 필터 선택: 해당 학기 반 코드만 표시되는지 확인

**Step 3: 커밋**

```bash
git add app.js
git commit -m "feat: sidebar class list uses active enrollments"
```

---

### Task 6: 그룹뷰에서 활성 enrollment 사용

**Files:**
- Modify: `app.js:796-824` (`renderGroupedList`)

**Step 1: `renderGroupedList()` 수정**

```javascript
// line 800 변경 (branch 그룹):
// 기존: const branches = branchesFromStudent(s);
// 변경:
const branches = activeFilters.semester ? branchesFromStudent(s) : activeBranchesFromStudent(s);

// line 807 변경 (class_code 그룹):
// 기존: const codes = allClassCodes(s);
// 변경:
const codes = activeFilters.semester ? allClassCodes(s) : activeClassCodes(s);
```

**Step 2: 검증**

- 그룹뷰(branch별): 활성 branch 기준 분류 확인
- 그룹뷰(반별): 활성 반 코드 기준 분류 확인

**Step 3: 커밋**

```bash
git add app.js
git commit -m "feat: group view uses active enrollments"
```

---

### Task 7: 상세화면 enrollment 카드에서 활성/이력 구분

**Files:**
- Modify: `app.js:1606-1638` (`renderEnrollmentCards`)

**Step 1: `renderEnrollmentCards()` 수정**

활성 enrollment과 이력을 구분하여 표시:

```javascript
function renderEnrollmentCards(studentData) {
    const container = document.getElementById('enrollment-list');
    if (!container) return;
    container.innerHTML = '';

    const enrollments = studentData.enrollments || [];
    if (enrollments.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:0.85em;">수업 정보가 없습니다.</p>';
        return;
    }

    const activeSet = new Set(getActiveEnrollments(studentData));

    // 활성 enrollment 먼저
    const activeList = enrollments.filter(e => activeSet.has(e));
    const historyList = enrollments.filter(e => !activeSet.has(e));

    if (activeList.length > 0) {
        activeList.forEach((e, idx) => {
            const realIdx = enrollments.indexOf(e);
            _renderEnrollmentCard(container, e, realIdx, false);
        });
    }

    if (historyList.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'enrollment-history-divider';
        divider.innerHTML = '<span>이전 학기 이력</span>';
        container.appendChild(divider);

        historyList.forEach((e) => {
            const realIdx = enrollments.indexOf(e);
            _renderEnrollmentCard(container, e, realIdx, true);
        });
    }
}

function _renderEnrollmentCard(container, e, idx, isHistory) {
    const code = enrollmentCode(e);
    const days = displayDays(e.day);
    const ct = e.class_type || '정규';
    const isRegular = ct === '정규';
    const semLabel = e.semester || '';
    const card = document.createElement('div');
    card.className = `enrollment-card${isHistory ? ' enrollment-history' : ''}`;
    card.innerHTML = `
        <div class="enrollment-card-header">
            <span class="enrollment-tag">${esc(code)}</span>
            <span class="enrollment-type">${esc(ct)}</span>
            ${semLabel ? `<span class="enrollment-semester">${esc(semLabel)}</span>` : ''}
            ${!isRegular && !isHistory ? `<button class="btn-end-class" onclick="window.endEnrollment(${idx})" title="종강처리">종강처리</button>` : ''}
        </div>
        <div class="enrollment-card-body">
            <div class="enrollment-field"><span class="field-label">요일</span><span>${esc(days)}</span></div>
            <div class="enrollment-field"><span class="field-label">${isRegular ? '등원일' : '시작일'}</span><span>${esc(formatDate(e.start_date))}</span></div>
            ${e.end_date ? `<div class="enrollment-field"><span class="field-label">종료일</span><span>${esc(formatDate(e.end_date))}</span></div>` : ''}
        </div>
    `;
    container.appendChild(card);
}
```

**Step 2: 이력 스타일 추가**

`style.css`에 추가:

```css
.enrollment-history-divider {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 8px;
    font-size: 0.8em;
    color: var(--text-sec);
}
.enrollment-history-divider::before,
.enrollment-history-divider::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--border);
}
.enrollment-card.enrollment-history {
    opacity: 0.55;
}
```

**Step 3: 검증**

- 임승찬 상세 열기: 활성 반(2026-Spring)이 위에, 이전 반(2026winter)이 "이전 학기 이력" 아래에 흐릿하게 표시
- 모든 이력이 보존되어 있는지 확인

**Step 4: 커밋**

```bash
git add app.js style.css
git commit -m "feat: separate active and history enrollments in detail view"
```

---

### Task 8: 상세화면 프로필 헤더에서 활성 enrollment 사용

**Files:**
- Modify: `app.js:955-1016` (`selectStudent`)

**Step 1: 프로필 branch/day 표시에 활성 enrollment 사용**

```javascript
// line 971 변경:
// 기존: const branch = branchesFromStudent(studentData).join(', ') || branchFromStudent(studentData);
// 변경:
const branch = activeBranchesFromStudent(studentData).join(', ') || branchFromStudent(studentData);

// line 991 변경:
// 기존: document.getElementById('profile-day').textContent = displayDays(combinedDays(studentData));
// 변경:
document.getElementById('profile-day').textContent = displayDays(activeDays(studentData));
```

**Step 2: 커밋**

```bash
git add app.js
git commit -m "feat: detail header shows active enrollment info"
```

---

### Task 9: 최종 통합 검증 및 배포

**Files:** 없음 (검증만)

**Step 1: 전체 시나리오 테스트**

| 시나리오 | 예상 결과 |
|---------|----------|
| 학기 필터 없음 → 임승찬 목록 | AX103(정규)만 표시 |
| 2026winter 필터 → 임승찬 | AYS + HX 표시 |
| 2026-Spring 필터 → 임승찬 | HX 표시 |
| 임승찬 상세 열기 | 활성: AX103. 이력: AYS, HX (2026winter) |
| 재원기간 | 최초 start_date 기준 (변동 없음) |
| 레벨 이력 | 모든 레벨 표시 (변동 없음) |
| 그룹뷰(반별) | 활성 반만 그룹에 포함 |
| 사이드바 반 목록 | 활성 반 코드만 표시 |

**Step 2: 빌드 및 배포**

```bash
npm run build
firebase deploy
```

**Step 3: 프로덕션 검증**

https://impact7db.web.app 에서 위 시나리오 재확인

**Step 4: 최종 커밋 (빌드)**

```bash
git add dist/
git commit -m "chore: build for deployment"
```
