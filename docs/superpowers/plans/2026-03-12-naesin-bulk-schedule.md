# 내신 시간표 일괄 설정 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable bulk exam (내신) schedule setup grouped by school+level+grade, with per-group day-pattern subgroups and individual exception overrides.

**Architecture:** Full-screen modal overlay following existing `modal-overlay`/`modal-card` pattern. Students are grouped by `school+level+grade`, each group can have multiple day-pattern subgroups (e.g., 월수금 5:30 / 화목토 7:00). Saving creates `class_type:'내신'` enrollment entries via Firestore batch writes. A module-level `_naesinState` object holds all UI state.

**Tech Stack:** Vanilla JS, Firestore (batch writes), existing CSS design system (modal-overlay, btn-save, btn-cancel, field-input)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `index.html:236` | Modify | Add 내신 시간표 button in actions bar |
| `index.html:896` | Modify | Add `#naesin-modal` before `<script>` tag |
| `style.css:2484` | Modify | Add naesin modal styles at end of file |
| `app.js:4620` | Modify | Add all 내신 schedule functions at end of file |

---

## Task 1: HTML — Entry Button + Modal Skeleton

**Files:**
- Modify: `index.html:236` (add button in `.actions` div)
- Modify: `index.html:896` (add modal before `<script>` tag)

- [ ] **Step 1: Add entry button in actions bar**

In `index.html` line 236, after the `group-view-btn` span and before the `refresh` span, add:

```html
<span class="material-symbols-outlined icon-btn" id="naesin-schedule-btn"
    title="내신 시간표 설정" onclick="window.openNaesinSchedule()"
    role="button" tabindex="0" aria-label="내신 시간표 설정">event_note</span>
```

- [ ] **Step 2: Add modal HTML skeleton**

Before line 897 (`<script type="module" src="app.js">`), add:

```html
<!-- 내신 시간표 일괄 설정 모달 -->
<div id="naesin-modal" class="modal-overlay" style="display:none"
     onclick="if(event.target===this)window.closeNaesinSchedule()"
     role="dialog" aria-modal="true" aria-label="내신 시간표 설정">
    <div class="modal-card naesin-modal-card">
        <h3 class="modal-title">
            <span class="material-symbols-outlined">event_note</span>
            내신 시간표 일괄 설정
        </h3>

        <!-- 기간 설정 -->
        <div class="naesin-period">
            <div class="naesin-period-row">
                <label>시작일</label>
                <input type="date" id="naesin-start-date" class="field-input">
                <label>종료일</label>
                <input type="date" id="naesin-end-date" class="field-input">
            </div>
        </div>

        <!-- 그룹 컨테이너 (동적 생성) -->
        <div id="naesin-groups" class="naesin-groups"></div>

        <!-- 액션 버튼 -->
        <div class="modal-actions">
            <button class="btn-cancel" onclick="window.closeNaesinSchedule()">취소</button>
            <button class="btn-save" id="naesin-save-btn" onclick="window.saveNaesinSchedule()">저장</button>
        </div>
    </div>
</div>
```

- [ ] **Step 3: Verify HTML renders**

Run: `npx vite build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: 내신 시간표 모달 HTML 스켈레톤 추가"
```

---

## Task 2: CSS — Modal and Group Styles

**Files:**
- Modify: `style.css:2484` (append new styles at end)

- [ ] **Step 1: Add naesin modal styles**

Append to `style.css` after line 2484:

```css
/* ── 내신 시간표 일괄 설정 ─────────────────────────────────────────────── */
.naesin-modal-card {
    width: 720px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 64px);
    overflow-y: auto;
}

.naesin-period-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.naesin-period-row label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-sec);
    white-space: nowrap;
}
.naesin-period-row .field-input {
    width: 150px;
}

.naesin-groups {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px 0;
}

/* 학교+학년 그룹 카드 */
.naesin-group {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px 14px;
    background: var(--surface);
}
.naesin-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    cursor: pointer;
}
.naesin-group-header h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-main);
}
.naesin-group-header .count {
    font-size: 12px;
    color: var(--text-sec);
    background: var(--bg);
    padding: 2px 8px;
    border-radius: 10px;
}
.naesin-group-body { display: flex; flex-direction: column; gap: 8px; }
.naesin-group.collapsed .naesin-group-body { display: none; }

/* 서브그룹 (요일 패턴) */
.naesin-subgroup {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 8px;
    flex-wrap: wrap;
}
.naesin-subgroup-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}
.naesin-day-checks {
    display: flex;
    gap: 2px;
}
.naesin-day-checks label {
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--border);
    user-select: none;
    transition: all 0.15s;
}
.naesin-day-checks input { display: none; }
.naesin-day-checks input:checked + span {
    background: var(--primary);
    color: #fff;
    border-color: var(--primary);
}
.naesin-day-checks label:has(input:checked) {
    background: var(--primary);
    color: #fff;
    border-color: var(--primary);
}
.naesin-time-input {
    width: 70px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
    text-align: center;
}

/* 학생 칩 목록 */
.naesin-students {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex: 1;
    min-width: 0;
}
.naesin-chip {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--bg);
    color: var(--text-main);
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
    white-space: nowrap;
}
.naesin-chip:hover { border-color: var(--primary); }
.naesin-chip.override {
    background: #fff3e0;
    border-color: #ff9800;
    color: #e65100;
}
.naesin-chip.unassigned {
    background: #fff;
    border: 1px dashed var(--border);
    color: var(--text-sec);
}

/* 서브그룹 추가/삭제 버튼 */
.naesin-add-subgroup {
    font-size: 12px;
    color: var(--primary);
    cursor: pointer;
    padding: 4px 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.naesin-add-subgroup:hover { text-decoration: underline; }
.naesin-remove-sub {
    font-size: 16px;
    color: var(--text-sec);
    cursor: pointer;
    line-height: 1;
}
.naesin-remove-sub:hover { color: #e53935; }

/* 개별 예외 팝오버 */
.naesin-override-popup {
    position: absolute;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 1100;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 200px;
}
.naesin-override-popup label { font-size: 12px; font-weight: 600; }

@media (max-width: 600px) {
    .naesin-modal-card { width: 100%; max-height: 90vh; }
    .naesin-subgroup { flex-direction: column; }
}
```

- [ ] **Step 2: Verify build**

Run: `npx vite build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "style: 내신 시간표 모달 CSS 추가"
```

---

## Task 3: JS — State Management + Open/Close + Group Builder

**Files:**
- Modify: `app.js:4620` (append new section at end of file)

- [ ] **Step 1: Add state and open/close functions**

Append to `app.js` after line 4620 (before the final empty line):

```js
// ===========================================================================
// 내신 시간표 일괄 설정
// ===========================================================================
let _naesinState = { startDate: '', endDate: '', groups: {} };

window.openNaesinSchedule = () => {
    _naesinState = { startDate: '', endDate: '', groups: {} };
    const modal = document.getElementById('naesin-modal');
    modal.style.display = 'flex';
    document.getElementById('naesin-start-date').value = '';
    document.getElementById('naesin-end-date').value = '';
    document.getElementById('naesin-groups').innerHTML =
        '<p style="color:var(--text-sec);font-size:13px;text-align:center;padding:20px 0;">시작일과 종료일을 설정하면 학생 그룹이 표시됩니다.</p>';

    // 날짜 변경 시 그룹 자동 빌드
    document.getElementById('naesin-start-date').onchange = buildNaesinGroups;
    document.getElementById('naesin-end-date').onchange = buildNaesinGroups;
};

window.closeNaesinSchedule = () => {
    document.getElementById('naesin-modal').style.display = 'none';
};
```

- [ ] **Step 2: Add buildNaesinGroups function**

Continue appending:

```js
function buildNaesinGroups() {
    const startDate = document.getElementById('naesin-start-date').value;
    const endDate = document.getElementById('naesin-end-date').value;
    if (!startDate || !endDate) return;
    _naesinState.startDate = startDate;
    _naesinState.endDate = endDate;

    // 재원/등원예정 중등·고등만 필터
    const activeStatuses = new Set(['재원', '등원예정']);
    const targets = allStudents.filter(s =>
        activeStatuses.has(s.status || '재원') &&
        (s.level === '중등' || s.level === '고등')
    );

    // school+level+grade 그룹핑
    const groupMap = {};
    for (const s of targets) {
        const school = s.school || '학교미입력';
        const levelShort = s.level === '중등' ? '중' : '고';
        const grade = s.grade || '?';
        const key = `${school}_${s.level}_${grade}`;
        const label = `${school.replace(/고등학교$/, '').replace(/중학교$/, '').replace(/초등학교$/, '').replace(/학교$/, '').trim()}${levelShort}${grade}`;
        if (!groupMap[key]) groupMap[key] = { label, students: [] };
        groupMap[key].students.push(s);
    }

    // 학생수 기준 정렬 (많은 순)
    const sortedKeys = Object.keys(groupMap).sort((a, b) => groupMap[b].students.length - groupMap[a].students.length);

    // state 초기화: 각 그룹에 빈 서브그룹 1개
    _naesinState.groups = {};
    for (const key of sortedKeys) {
        const g = groupMap[key];
        _naesinState.groups[key] = {
            label: g.label,
            subgroups: [{ days: [], time: '', studentIds: g.students.map(s => s.id) }],
            overrides: {}  // studentId → { days, time }
        };
    }

    renderNaesinGroups();
}
```

- [ ] **Step 3: Add renderNaesinGroups function**

Continue appending:

```js
const DAYS_LIST = ['월', '화', '수', '목', '금', '토'];

function renderNaesinGroups() {
    const container = document.getElementById('naesin-groups');
    const groups = _naesinState.groups;
    const keys = Object.keys(groups);

    if (keys.length === 0) {
        container.innerHTML = '<p style="color:var(--text-sec);font-size:13px;text-align:center;padding:20px 0;">해당하는 학생이 없습니다.</p>';
        return;
    }

    container.innerHTML = keys.map(key => {
        const g = groups[key];
        const totalStudents = g.subgroups.reduce((n, sg) => n + sg.studentIds.length, 0);
        const overrideCount = Object.keys(g.overrides).length;

        return `<div class="naesin-group" data-key="${key}">
            <div class="naesin-group-header" onclick="this.parentElement.classList.toggle('collapsed')">
                <h4>${esc(g.label)}</h4>
                <span class="count">${totalStudents}명${overrideCount ? ` (예외 ${overrideCount})` : ''}</span>
            </div>
            <div class="naesin-group-body">
                ${g.subgroups.map((sg, si) => renderNaesinSubgroup(key, sg, si, g)).join('')}
                <span class="naesin-add-subgroup" onclick="window.addNaesinSubgroup('${key}')">
                    <span class="material-symbols-outlined" style="font-size:14px;">add</span> 서브그룹 추가
                </span>
            </div>
        </div>`;
    }).join('');
}

function renderNaesinSubgroup(groupKey, sg, subIdx, group) {
    const dayChecks = DAYS_LIST.map(d => {
        const checked = sg.days.includes(d) ? 'checked' : '';
        return `<label><input type="checkbox" value="${d}" ${checked}
            onchange="window.updateNaesinSubDays('${groupKey}',${subIdx})"><span>${d}</span></label>`;
    }).join('');

    const students = sg.studentIds.map(id => {
        const s = allStudents.find(st => st.id === id);
        if (!s) return '';
        const hasOverride = !!group.overrides[id];
        const cls = hasOverride ? 'naesin-chip override' : 'naesin-chip';
        const overrideInfo = hasOverride
            ? ` title="${group.overrides[id].days.join('')} ${group.overrides[id].time}"`
            : '';
        return `<span class="${cls}" data-id="${id}"${overrideInfo}
            onclick="window.openNaesinOverride(event,'${groupKey}',${subIdx},'${id}')">${esc(s.name)}</span>`;
    }).join('');

    const removeBtn = subIdx > 0
        ? `<span class="naesin-remove-sub material-symbols-outlined" onclick="window.removeNaesinSubgroup('${groupKey}',${subIdx})" title="삭제">close</span>`
        : '';

    return `<div class="naesin-subgroup" data-sub="${subIdx}">
        <div class="naesin-subgroup-controls">
            <div class="naesin-day-checks">${dayChecks}</div>
            <input type="time" class="naesin-time-input" value="${sg.time}"
                onchange="window.updateNaesinSubTime('${groupKey}',${subIdx},this.value)">
            ${removeBtn}
        </div>
        <div class="naesin-students">${students || '<span style="color:var(--text-sec);font-size:12px;">학생 없음</span>'}</div>
    </div>`;
}
```

- [ ] **Step 4: Verify build**

Run: `npx vite build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: 내신 시간표 — 상태 관리 + 그룹 빌더 + 렌더링"
```

---

## Task 4: JS — Subgroup Management + Student Movement

**Files:**
- Modify: `app.js` (continue appending)

- [ ] **Step 1: Add subgroup CRUD functions**

Append to `app.js`:

```js
// ---------------------------------------------------------------------------
// 서브그룹 관리
// ---------------------------------------------------------------------------
window.addNaesinSubgroup = (groupKey) => {
    const g = _naesinState.groups[groupKey];
    if (!g) return;
    g.subgroups.push({ days: [], time: '', studentIds: [] });
    renderNaesinGroups();
};

window.removeNaesinSubgroup = (groupKey, subIdx) => {
    const g = _naesinState.groups[groupKey];
    if (!g || subIdx === 0) return;
    // 삭제되는 서브그룹의 학생들을 첫 번째 서브그룹으로 이동
    const removed = g.subgroups.splice(subIdx, 1)[0];
    g.subgroups[0].studentIds.push(...removed.studentIds);
    // 해당 학생의 override도 제거
    for (const id of removed.studentIds) delete g.overrides[id];
    renderNaesinGroups();
};

window.updateNaesinSubDays = (groupKey, subIdx) => {
    const g = _naesinState.groups[groupKey];
    if (!g) return;
    const groupEl = document.querySelector(`.naesin-group[data-key="${groupKey}"]`);
    const subEl = groupEl?.querySelectorAll('.naesin-subgroup')[subIdx];
    if (!subEl) return;
    const checked = [...subEl.querySelectorAll('.naesin-day-checks input:checked')].map(cb => cb.value);
    g.subgroups[subIdx].days = checked;
};

window.updateNaesinSubTime = (groupKey, subIdx, value) => {
    const g = _naesinState.groups[groupKey];
    if (!g) return;
    g.subgroups[subIdx].time = value;
};
```

- [ ] **Step 2: Add student click → move between subgroups**

Continue appending:

```js
// ---------------------------------------------------------------------------
// 학생 클릭 → 서브그룹 이동 또는 개별 예외 설정
// ---------------------------------------------------------------------------
window.openNaesinOverride = (event, groupKey, subIdx, studentId) => {
    event.stopPropagation();
    // 기존 팝업 닫기
    document.querySelectorAll('.naesin-override-popup').forEach(el => el.remove());

    const g = _naesinState.groups[groupKey];
    if (!g) return;
    const s = allStudents.find(st => st.id === studentId);
    if (!s) return;

    const existingOverride = g.overrides[studentId];
    const popup = document.createElement('div');
    popup.className = 'naesin-override-popup';

    // 서브그룹 이동 옵션
    const moveOptions = g.subgroups.map((sg, i) => {
        if (i === subIdx) return '';
        const label = sg.days.length > 0 ? `${sg.days.join('')} ${sg.time || ''}` : `서브그룹 ${i + 1}`;
        return `<button class="btn-cancel" style="font-size:12px;padding:4px 8px;" onclick="window.moveNaesinStudent('${groupKey}',${subIdx},${i},'${studentId}')">→ ${esc(label)}</button>`;
    }).filter(Boolean).join('');

    // 개별 예외 설정
    const ovDays = existingOverride ? existingOverride.days : g.subgroups[subIdx].days;
    const ovTime = existingOverride ? existingOverride.time : g.subgroups[subIdx].time;
    const dayChecks = DAYS_LIST.map(d =>
        `<label style="font-size:12px;"><input type="checkbox" value="${d}" ${ovDays.includes(d) ? 'checked' : ''}><span>${d}</span></label>`
    ).join(' ');

    popup.innerHTML = `
        <label>${esc(s.name)} — 개별 설정</label>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${dayChecks}</div>
        <input type="time" class="naesin-time-input" value="${ovTime}" style="width:100px;">
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn-save" style="font-size:12px;padding:4px 10px;" onclick="window.applyNaesinOverride('${groupKey}','${studentId}',this)">적용</button>
            ${existingOverride ? `<button class="btn-cancel" style="font-size:12px;padding:4px 10px;" onclick="window.clearNaesinOverride('${groupKey}','${studentId}')">예외 해제</button>` : ''}
        </div>
        ${g.subgroups.length > 1 ? `<hr style="margin:4px 0;border:none;border-top:1px solid var(--border);"><label>서브그룹 이동</label>${moveOptions}` : ''}
    `;

    // 위치 계산
    const chip = event.target;
    const rect = chip.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
    popup.style.top = (rect.bottom + 4) + 'px';
    document.body.appendChild(popup);

    // 바깥 클릭 시 닫기
    const closeHandler = (e) => {
        if (!popup.contains(e.target) && e.target !== chip) {
            popup.remove();
            document.removeEventListener('mousedown', closeHandler);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
};

window.moveNaesinStudent = (groupKey, fromIdx, toIdx, studentId) => {
    const g = _naesinState.groups[groupKey];
    if (!g) return;
    g.subgroups[fromIdx].studentIds = g.subgroups[fromIdx].studentIds.filter(id => id !== studentId);
    g.subgroups[toIdx].studentIds.push(studentId);
    delete g.overrides[studentId];
    document.querySelectorAll('.naesin-override-popup').forEach(el => el.remove());
    renderNaesinGroups();
};

window.applyNaesinOverride = (groupKey, studentId, btn) => {
    const popup = btn.closest('.naesin-override-popup');
    const days = [...popup.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
    const time = popup.querySelector('input[type="time"]').value;
    if (days.length === 0) { alert('요일을 선택해주세요.'); return; }
    _naesinState.groups[groupKey].overrides[studentId] = { days, time };
    popup.remove();
    renderNaesinGroups();
};

window.clearNaesinOverride = (groupKey, studentId) => {
    delete _naesinState.groups[groupKey].overrides[studentId];
    document.querySelectorAll('.naesin-override-popup').forEach(el => el.remove());
    renderNaesinGroups();
};
```

- [ ] **Step 3: Verify build**

Run: `npx vite build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: 내신 시간표 — 서브그룹 관리 + 학생 이동 + 개별 예외"
```

---

## Task 5: JS — Save to Firestore

**Files:**
- Modify: `app.js` (continue appending)

- [ ] **Step 1: Add saveNaesinSchedule function**

Append to `app.js`:

```js
// ---------------------------------------------------------------------------
// 내신 시간표 저장 (Firestore batch write)
// ---------------------------------------------------------------------------
window.saveNaesinSchedule = async () => {
    const { startDate, endDate, groups } = _naesinState;
    if (!startDate || !endDate) { alert('내신 기간을 설정해주세요.'); return; }
    if (endDate <= startDate) { alert('종료일은 시작일 이후여야 합니다.'); return; }

    // 모든 그룹에서 설정된 학생 수집
    const writes = []; // { studentId, days, time }
    const warnings = [];

    for (const [key, g] of Object.entries(groups)) {
        for (const sg of g.subgroups) {
            for (const id of sg.studentIds) {
                const override = g.overrides[id];
                const days = override ? override.days : sg.days;
                const time = override ? override.time : sg.time;

                if (days.length === 0) {
                    const s = allStudents.find(st => st.id === id);
                    warnings.push(s?.name || id);
                    continue;
                }
                writes.push({ studentId: id, days, time });
            }
        }
    }

    if (warnings.length > 0) {
        alert(`요일 미설정 학생이 있습니다:\n${warnings.join(', ')}\n\n요일을 설정하거나 서브그룹에서 제외해주세요.`);
        return;
    }

    if (writes.length === 0) { alert('저장할 학생이 없습니다.'); return; }

    // 중복 내신 체크: 같은 기간에 이미 내신 enrollment이 있는 학생
    const conflicts = [];
    for (const w of writes) {
        const s = allStudents.find(st => st.id === w.studentId);
        if (!s) continue;
        const hasNaesin = (s.enrollments || []).some(e =>
            e.class_type === '내신' &&
            e.start_date === startDate && e.end_date === endDate
        );
        if (hasNaesin) conflicts.push(s.name);
    }
    if (conflicts.length > 0) {
        if (!confirm(`다음 학생에 동일 기간 내신이 이미 있습니다:\n${conflicts.join(', ')}\n\n기존 내신을 덮어쓰시겠습니까?`)) return;
    }

    if (!confirm(`${writes.length}명에게 내신 시간표를 적용합니다.\n기간: ${startDate} ~ ${endDate}\n\n진행하시겠습니까?`)) return;

    const saveBtn = document.getElementById('naesin-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';

    try {
        const semester = activeFilters.semester || currentSemester || '';
        const BATCH_SIZE = 200;

        for (let i = 0; i < writes.length; i += BATCH_SIZE) {
            const chunk = writes.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);

            for (const w of chunk) {
                const s = allStudents.find(st => st.id === w.studentId);
                if (!s) continue;

                const newEnrollment = {
                    class_type: '내신',
                    day: w.days,
                    time: w.time,
                    start_date: startDate,
                    end_date: endDate,
                    class_number: '',
                    level_symbol: '',
                    semester,
                };

                // 동일 기간 내신 있으면 교체, 없으면 추가
                let enrollments = [...(s.enrollments || [])];
                const existIdx = enrollments.findIndex(e =>
                    e.class_type === '내신' && e.start_date === startDate && e.end_date === endDate
                );
                if (existIdx >= 0) {
                    enrollments[existIdx] = newEnrollment;
                } else {
                    enrollments.push(newEnrollment);
                }

                batch.update(doc(db, 'students', w.studentId), { enrollments });
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: w.studentId,
                    change_type: 'UPDATE',
                    before: '—',
                    after: `내신 추가: ${w.days.join('')} ${w.time} (${startDate}~${endDate}) (내신일괄설정)`,
                    google_login_id: currentUser?.email || '—',
                    timestamp: serverTimestamp(),
                });

                // 로컬 동기화
                if (existIdx >= 0) {
                    s.enrollments[existIdx] = newEnrollment;
                } else {
                    s.enrollments = [...(s.enrollments || []), newEnrollment];
                }
            }

            await batch.commit();
        }

        applyFilterAndRender();
        window.closeNaesinSchedule();
        alert(`${writes.length}명의 내신 시간표를 저장했습니다.`);
    } catch (e) {
        console.error('[NAESIN SAVE ERROR]', e);
        alert('내신 시간표 저장 실패: ' + e.message);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
    }
};
```

- [ ] **Step 2: Verify build**

Run: `npx vite build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: 내신 시간표 — Firestore 일괄 저장 + 중복 체크 + 히스토리 로그"
```

---

## Task 6: Integration Test (Manual)

- [ ] **Step 1: Run dev server and test full flow**

Run: `npx vite`

1. Open app, click `event_note` icon button
2. Set 내신 기간 (start/end dates) → verify groups appear
3. Set days and time on a group → verify checkboxes and time input work
4. Add a subgroup → verify it appears with "학생 없음"
5. Click student chip → verify override popup, move between subgroups
6. Set individual override → verify chip turns orange
7. Click "저장" → verify confirm dialog, then check Firestore console for enrollment data
8. Refresh page → verify 내신 enrollments are loaded and 정규 is hidden during active 내신 period

- [ ] **Step 2: Final commit with all files**

```bash
git add -A
git commit -m "feat: 내신 시간표 일괄 설정 기능 추가"
```
