/**
 * promo-extractor.js — Analytics 인라인 뷰
 *
 * 사이드바 최하단 "Analytics"에서 진입. list-panel을 통째로 차지.
 * 상태 + 학부×학년 그리드로 학생을 필터링하고, 비원생은
 * normalizeRealLevelGrade로 현재 실제 학년 환산. 결과는 클립보드 복사
 * 또는 Google Sheets로 내보낼 수 있다.
 */
import { state } from './store.js';
import { studentFullLabel } from '@impact7/shared/student-label';
import { ENROLLABLE_STATUSES } from '@impact7/shared/enrollment-status';
import { todayKST } from '@impact7/shared/datetime';
import {
    normalizeRealLevelGrade,
    gridKeyFor,
    mergeByPhone,
    branchFromStudent,
} from './promo-extractor-core.js';
import { createGoogleSheet } from './sheet-export.js';

const PAST_STATUSES = new Set(['퇴원', '종강']);
const ACTIVE_STATUSES = ENROLLABLE_STATUSES;

const todayStr = todayKST;

function enrollCode(e) {
    return `${e?.level_symbol || ''}${e?.class_number || ''}`;
}

function pickActiveCodes(s) {
    const today = todayStr();
    const active = (s.enrollments || []).filter(e => !e.end_date || e.end_date >= today);
    const codes = active.map(enrollCode).filter(Boolean);
    return [...new Set(codes)].join(', ');
}

function pickLastCode(s) {
    if (!s.enrollments || s.enrollments.length === 0) return '';
    const sorted = [...s.enrollments].sort((a, b) =>
        (b.end_date || b.start_date || '').localeCompare(a.end_date || a.start_date || ''));
    return enrollCode(sorted[0]);
}

// 그리드 정의 (초1~3은 비활성, 졸업 제거)
const GRID_ROWS = [
    { level: '초등', grades: [4, 5, 6] },
    { level: '중등', grades: [1, 2, 3] },
    { level: '고등', grades: [1, 2, 3] },
];

// 전화 필드 → 표시 라벨
const PHONE_LABELS = {
    parent_phone_1: '학부모1',
    student_phone:  '학생',
    parent_phone_2: '학부모2',
};
// 일관된 우선순위 순서 (UI 체크 순서와 무관하게 항상 이 순서로 정렬)
const PHONE_ORDER = ['parent_phone_1', 'student_phone', 'parent_phone_2'];

// 모달 상태
let currentStatusFilter = 'active'; // 'all' | 'active' | 'past'
let currentBranchFilter = 'all';    // 'all' | '2단지' | '10단지' | '소속없음'
let selectedGridKeys = new Set();   // 예: {'초등3','중등1'}
let selectedPhoneFields = ['parent_phone_1']; // 우선순위 순서대로
let mergePhones = true;
let sortState = { col: null, dir: 'asc' };
let lastRenderedRows = [];          // 마지막 렌더된 행(체크박스 토글용)

// ─── 진입점 (인라인 뷰 — daily-stats 패턴) ───────────────────────────
let _autoHideBound = false;

window.openPromoExtractView = function () {
    const view = document.getElementById('promo-extract-view');
    const listPanel = document.querySelector('.list-panel');
    if (!view || !listPanel) return;

    // 다른 뷰 모두 숨김
    const homeView = document.getElementById('home-view');
    const statsView = document.getElementById('daily-stats-view');
    if (homeView) homeView.style.display = 'none';
    if (statsView) statsView.style.display = 'none';

    // panel-header / bulk-bar / list-items 숨김
    const panelHeader = listPanel.querySelector('.panel-header');
    const bulkBar = document.getElementById('bulk-action-bar');
    const listItems = listPanel.querySelector('.list-items');
    if (panelHeader) panelHeader.style.display = 'none';
    if (bulkBar) bulkBar.style.display = 'none';
    if (listItems) listItems.style.display = 'none';

    view.style.display = 'flex';
    initView();
    bindAutoHide();
};

window.hidePromoExtractView = function () {
    const view = document.getElementById('promo-extract-view');
    const listPanel = document.querySelector('.list-panel');
    if (!view || !listPanel) return;

    view.style.display = 'none';
    const panelHeader = listPanel.querySelector('.panel-header');
    const listItems = listPanel.querySelector('.list-items');
    if (panelHeader) panelHeader.style.display = '';
    if (listItems) listItems.style.display = '';
};

// 사이드바 L1/필터 항목 클릭 시 Analytics 뷰 자동 hide (한 번만 등록)
function bindAutoHide() {
    if (_autoHideBound) return;
    _autoHideBound = true;
    const hideIfShown = () => {
        if (document.getElementById('promo-extract-view').style.display !== 'none') {
            window.hidePromoExtractView();
        }
    };
    document
        .querySelectorAll('.sidebar > details.l1-group > summary, .sidebar .nav-item[data-filter-type]')
        .forEach(el => el.addEventListener('click', hideIfShown));
}

function initView() {
    buildGrid();
    bindFilterEvents();
    bindActionEvents();
    refresh();
}

function buildGrid() {
    const tbody = document.getElementById('promo-grid-body');
    tbody.innerHTML = '';

    for (const row of GRID_ROWS) {
        const tr = document.createElement('tr');
        const labelTd = document.createElement('td');
        labelTd.textContent = row.level;
        tr.appendChild(labelTd);

        for (let g = 1; g <= 6; g++) {
            const td = document.createElement('td');
            if (row.grades.includes(g)) {
                td.innerHTML = `<input type="checkbox" class="promo-grid-cell" data-key="${row.level}${g}" checked>`;
            } else {
                td.classList.add('disabled');
                td.textContent = '–';
            }
            tr.appendChild(td);
        }

        // 행 전체 토글
        const toggleTd = document.createElement('td');
        toggleTd.classList.add('promo-grid-toggle-col');
        toggleTd.innerHTML = `<input type="checkbox" class="promo-grid-row-toggle" data-level="${row.level}" checked>`;
        tr.appendChild(toggleTd);

        tbody.appendChild(tr);
    }

    // 초기 선택 키 = 모든 셀
    selectedGridKeys = new Set(
        [...tbody.querySelectorAll('.promo-grid-cell')].map(el => el.dataset.key)
    );
}

function bindFilterEvents() {
    // 상태 chips
    document.querySelectorAll('#promo-status-chips .promo-chip').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#promo-status-chips .promo-chip').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentStatusFilter = btn.dataset.status;
            refresh();
        };
    });

    // 소속 chips
    document.querySelectorAll('#promo-branch-chips .promo-chip').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#promo-branch-chips .promo-chip').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentBranchFilter = btn.dataset.branch;
            refresh();
        };
    });

    // 그리드 셀
    document.querySelectorAll('.promo-grid-cell').forEach(cb => {
        cb.onchange = () => {
            const key = cb.dataset.key;
            if (cb.checked) selectedGridKeys.add(key);
            else selectedGridKeys.delete(key);
            syncRowToggles();
            syncGridAllToggle();
            refresh();
        };
    });

    // 행 전체 토글
    document.querySelectorAll('.promo-grid-row-toggle').forEach(cb => {
        cb.onchange = () => {
            const level = cb.dataset.level;
            const cells = document.querySelectorAll(`.promo-grid-cell[data-key^="${level}"]`);
            cells.forEach(cell => {
                cell.checked = cb.checked;
                const key = cell.dataset.key;
                if (cb.checked) selectedGridKeys.add(key);
                else selectedGridKeys.delete(key);
            });
            syncGridAllToggle();
            refresh();
        };
    });

    // 전체 토글
    document.getElementById('promo-grid-all').onchange = (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.promo-grid-cell').forEach(cell => {
            cell.checked = checked;
            const key = cell.dataset.key;
            if (checked) selectedGridKeys.add(key);
            else selectedGridKeys.delete(key);
        });
        document.querySelectorAll('.promo-grid-row-toggle').forEach(t => t.checked = checked);
        refresh();
    };

    // 전화번호 선택 — 체크 변경 시 PHONE_ORDER 기준으로 정렬된 배열 유지
    document.querySelectorAll('.promo-phone-cb').forEach(cb => {
        cb.onchange = () => {
            const checked = new Set(
                [...document.querySelectorAll('.promo-phone-cb:checked')].map(el => el.dataset.phone)
            );
            selectedPhoneFields = PHONE_ORDER.filter(f => checked.has(f));
            refresh();
        };
    });

    // 병합 토글
    document.getElementById('promo-merge-phones').onchange = (e) => {
        mergePhones = e.target.checked;
        refresh();
    };

    // 헤더 정렬은 refresh() 안에서 동적 헤더 만들 때 같이 바인딩
}

function syncRowToggles() {
    for (const row of GRID_ROWS) {
        const cells = document.querySelectorAll(`.promo-grid-cell[data-key^="${row.level}"]`);
        const allChecked = [...cells].every(c => c.checked);
        const toggle = document.querySelector(`.promo-grid-row-toggle[data-level="${row.level}"]`);
        if (toggle) toggle.checked = allChecked;
    }
}

function syncGridAllToggle() {
    const allCells = document.querySelectorAll('.promo-grid-cell');
    const allChecked = [...allCells].every(c => c.checked);
    document.getElementById('promo-grid-all').checked = allChecked;
}

// ─── 필터링 ─────────────────────────────────────────────────────────
function buildRows() {
    const students = state.allStudents || [];

    // 1. 상태 필터
    const statusFiltered = students.filter(s => {
        if (currentStatusFilter === 'all')    return ACTIVE_STATUSES.has(s.status) || PAST_STATUSES.has(s.status);
        if (currentStatusFilter === 'active') return ACTIVE_STATUSES.has(s.status);
        if (currentStatusFilter === 'past')   return PAST_STATUSES.has(s.status);
        return false;
    });

    // 2. 정규화 + 그리드 매칭 + 소속 매칭 + 전화 추출
    let phoneMissing = 0;
    const rows = [];
    for (const s of statusFiltered) {
        const norm = normalizeRealLevelGrade(s);
        const key = gridKeyFor(norm);
        if (!selectedGridKeys.has(key)) continue;

        const branch = branchFromStudent(s); // '2단지' | '10단지' | ''
        if (currentBranchFilter !== 'all') {
            const expected = currentBranchFilter === '소속없음' ? '' : currentBranchFilter;
            if (branch !== expected) continue;
        }

        // 선택된 필드들의 번호를 모두 수집 — 하나라도 있으면 통과
        const phones = {};
        let anyPhone = null;
        for (const f of selectedPhoneFields) {
            const v = s[f];
            const trimmed = v ? String(v).trim() : '';
            phones[f] = trimmed;
            if (trimmed && !anyPhone) anyPhone = trimmed;
        }
        if (!anyPhone) { phoneMissing++; continue; }

        const isPast = PAST_STATUSES.has(s.status);
        rows.push({
            id: s.id,
            name: s.name || '',
            branch,
            schoolGrade: studentFullLabel(s),
            classCode: isPast ? pickLastCode(s) : pickActiveCodes(s),
            phone: anyPhone, // 정렬·병합 키 (선택 중 가장 우선순위 높은 번호)
            phones,          // { parent_phone_1: '010-1', student_phone: '' ... }
            status: s.status || '',
        });
    }

    // 3. 중복 병합
    let mergedCount = 0;
    let finalRows = rows;
    if (mergePhones) {
        const before = rows.length;
        finalRows = mergeByPhone(rows);
        mergedCount = before - finalRows.length;
    } else {
        finalRows = rows.map(r => ({ ...r, mergedNames: [r.name] }));
    }

    // 4. 정렬 (col이 'phones.parent_phone_1' 식이면 중첩 키 추출)
    if (sortState.col) {
        const col = sortState.col;
        const dir = sortState.dir === 'asc' ? 1 : -1;
        const getVal = (row) => {
            if (col.startsWith('phones.')) {
                const f = col.slice('phones.'.length);
                return String(row.phones?.[f] ?? '');
            }
            return String(row[col] ?? '');
        };
        finalRows = [...finalRows].sort((a, b) => getVal(a).localeCompare(getVal(b), 'ko') * dir);
    }

    return { rows: finalRows, phoneMissing, mergedCount };
}

// ─── 렌더링 ─────────────────────────────────────────────────────────
function refresh() {
    const { rows, phoneMissing, mergedCount } = buildRows();
    lastRenderedRows = rows;

    // 카운트
    const parts = [`매칭 ${rows.length}명`];
    if (phoneMissing > 0) parts.push(`전화 누락 ${phoneMissing}명 제외`);
    if (mergedCount > 0) parts.push(`중복 ${mergedCount}건 병합`);
    document.getElementById('promo-summary').textContent = parts.join(' · ');

    // 헤더 동적 생성 (전화번호 컬럼이 선택에 따라 가변)
    const thead = document.getElementById('promo-table-head');
    const phoneHeaderCells = selectedPhoneFields.map(f =>
        `<th class="promo-sortable" data-col="phones.${f}">${PHONE_LABELS[f]} <span class="promo-sort-icon"></span></th>`
    ).join('');
    thead.innerHTML = `
        <tr>
            <th></th>
            <th class="promo-sortable" data-col="name">이름 <span class="promo-sort-icon"></span></th>
            <th class="promo-sortable" data-col="branch">소속 <span class="promo-sort-icon"></span></th>
            <th class="promo-sortable" data-col="schoolGrade">학교학년 <span class="promo-sort-icon"></span></th>
            <th class="promo-sortable" data-col="classCode">반 <span class="promo-sort-icon"></span></th>
            ${phoneHeaderCells}
            <th class="promo-sortable" data-col="status">상태 <span class="promo-sort-icon"></span></th>
        </tr>
    `;
    // 헤더 클릭 정렬 — 매 렌더마다 재바인딩(동적 컬럼)
    thead.querySelectorAll('.promo-sortable').forEach(th => {
        th.onclick = () => {
            const col = th.dataset.col;
            if (sortState.col !== col)        sortState = { col, dir: 'asc' };
            else if (sortState.dir === 'asc') sortState = { col, dir: 'desc' };
            else                              sortState = { col: null, dir: 'asc' };
            refresh();
        };
        const icon = th.querySelector('.promo-sort-icon');
        if (icon) icon.textContent =
            th.dataset.col === sortState.col ? (sortState.dir === 'asc' ? '▲' : '▼') : '';
    });

    // 테이블 body
    const tbody = document.getElementById('promo-table-body');
    tbody.innerHTML = '';
    const colCount = 6 + selectedPhoneFields.length; // checkbox+name+branch+schoolGrade+classCode+status + phones
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${colCount}" class="promo-empty">조건에 맞는 학생이 없습니다</td></tr>`;
        document.getElementById('promo-select-all').checked = false;
        return;
    }

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const tr = document.createElement('tr');
        const displayName = r.mergedNames.length > 1 ? r.mergedNames.join(', ') : r.name;
        const phoneCells = selectedPhoneFields.map(f =>
            `<td class="promo-phone-cell">${escapeHtml(r.phones[f] || '')}</td>`
        ).join('');
        tr.innerHTML = `
            <td><input type="checkbox" class="promo-row-check" data-idx="${i}" checked></td>
            <td>${escapeHtml(displayName)}</td>
            <td>${escapeHtml(r.branch)}</td>
            <td>${escapeHtml(r.schoolGrade)}</td>
            <td>${escapeHtml(r.classCode)}</td>
            ${phoneCells}
            <td>${escapeHtml(r.status)}</td>
        `;
        tbody.appendChild(tr);
    }
    document.getElementById('promo-select-all').checked = true;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ─── 액션 ─────────────────────────────────────────────────────────
function bindActionEvents() {
    document.getElementById('promo-select-all').onchange = (e) => {
        document.querySelectorAll('.promo-row-check').forEach(cb => cb.checked = e.target.checked);
    };
    document.getElementById('promo-copy-btn').onclick = handleCopy;
    document.getElementById('promo-sheet-btn').onclick = handleSheetExport;
}

function getCheckedRows() {
    const checked = [...document.querySelectorAll('.promo-row-check:checked')]
        .map(cb => parseInt(cb.dataset.idx, 10));
    return checked.map(idx => lastRenderedRows[idx]).filter(Boolean);
}

async function handleCopy() {
    const rows = getCheckedRows();
    if (rows.length === 0) {
        alert('선택된 행이 없습니다.');
        return;
    }
    // 선택된 모든 전화 필드의 번호를 평탄화 (공란 제외, 전체 중복 제거)
    const all = [];
    for (const r of rows) {
        for (const f of selectedPhoneFields) {
            if (r.phones[f]) all.push(r.phones[f]);
        }
    }
    const text = [...new Set(all)].join(',');

    try {
        await navigator.clipboard.writeText(text);
        alert(`${rows.length}개 번호를 복사했습니다.`);
    } catch (e) {
        // fallback: textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            alert(`${rows.length}개 번호를 복사했습니다.`);
        } catch (fallbackErr) {
            alert('복사 실패: ' + fallbackErr.message);
        } finally {
            document.body.removeChild(ta);
        }
    }
}

async function handleSheetExport() {
    const rows = getCheckedRows();
    if (rows.length === 0) {
        alert('선택된 행이 없습니다.');
        return;
    }

    const today = todayStr();
    const filterSummary = buildFilterSummary();
    const title = `인원현황_${today}${filterSummary ? '_' + filterSummary : ''}`;
    const phoneHeaders = selectedPhoneFields.map(f => PHONE_LABELS[f]);
    const headers = ['이름', '소속', '학교학년', '반', ...phoneHeaders, '상태'];
    const sheetRows = rows.map(r => {
        const displayName = r.mergedNames.length > 1 ? r.mergedNames.join(', ') : r.name;
        const phoneCells = selectedPhoneFields.map(f => r.phones[f] || '');
        return [displayName, r.branch, r.schoolGrade, r.classCode, ...phoneCells, r.status];
    });

    await createGoogleSheet(title, headers, sheetRows);
}

function buildFilterSummary() {
    const parts = [];
    if (currentStatusFilter === 'active') parts.push('재원');
    else if (currentStatusFilter === 'past') parts.push('비원');

    if (currentBranchFilter !== 'all') parts.push(currentBranchFilter);

    // 그리드 부분 선택일 때만 파일명에 키 표기 (전체 선택이면 생략)
    const totalCells = GRID_ROWS.reduce((sum, r) => sum + r.grades.length, 0);
    const keys = [...selectedGridKeys].sort();
    if (keys.length > 0 && keys.length < totalCells) parts.push(keys.join('·'));
    return parts.join('_');
}
