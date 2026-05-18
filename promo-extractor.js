/**
 * promo-extractor.js — 홍보 수신자 추출 모달
 *
 * 좌측 사이드바 "홍보 추출" 버튼에서 진입.
 * 상태 + 학부×학년 그리드 필터로 학생을 추려 대표번호 추출.
 * 비원생은 normalizeRealLevelGrade로 현재 실제 학년으로 변환.
 */
import { state } from './store.js';
import {
    normalizeRealLevelGrade,
    pickPrimaryPhone,
    gridKeyFor,
    mergeByPhone,
} from './promo-extractor-core.js';
import { createGoogleSheet } from './sheet-export.js';

const PAST_STATUSES = new Set(['퇴원', '종강']);
const ACTIVE_STATUSES = new Set(['등원예정', '재원', '실휴원', '가휴원']);

// 그리드 정의
const GRID_ROWS = [
    { level: '초등', grades: [1, 2, 3, 4, 5, 6] },
    { level: '중등', grades: [1, 2, 3] },
    { level: '고등', grades: [1, 2, 3] },
    { level: '졸업', grades: null }, // 단일 셀
];

// 모달 상태
let currentStatusFilter = 'active'; // 'all' | 'active' | 'past'
let selectedGridKeys = new Set();   // 예: {'초등3','중등1','졸업'}
let mergePhones = true;
let lastRenderedRows = [];          // 마지막 렌더된 행(체크박스 토글용)

// ─── 진입점 ─────────────────────────────────────────────────────────
window.openPromoExtractModal = function () {
    const modal = document.getElementById('promo-extract-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    initModal();
};

window.closePromoExtractModal = function () {
    // overlay 클릭 / 닫기 버튼 둘 다 단순 닫기.
    // (modal-content에 event.stopPropagation()이 있어 내부 클릭은 여기로 안 옴)
    document.getElementById('promo-extract-modal').style.display = 'none';
};

// ─── 초기화 ─────────────────────────────────────────────────────────
function initModal() {
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

        if (row.grades === null) {
            // 졸업: 1~6 셀 자리에 colspan, 단일 체크박스
            const cell = document.createElement('td');
            cell.colSpan = 6;
            cell.innerHTML = `<input type="checkbox" class="promo-grid-cell" data-key="졸업" checked>`;
            tr.appendChild(cell);
        } else {
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

    // 병합 토글
    document.getElementById('promo-merge-phones').onchange = (e) => {
        mergePhones = e.target.checked;
        refresh();
    };
}

function syncRowToggles() {
    for (const row of GRID_ROWS) {
        if (row.grades === null) continue;
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

    // 2. 정규화 + 그리드 매칭 + 전화 추출
    let phoneMissing = 0;
    const rows = [];
    for (const s of statusFiltered) {
        const norm = normalizeRealLevelGrade(s);
        const key = gridKeyFor(norm);
        if (!selectedGridKeys.has(key)) continue;

        const phone = pickPrimaryPhone(s);
        if (!phone) { phoneMissing++; continue; }

        rows.push({
            id: s.id,
            name: s.name || '',
            level: norm.level,
            grade: norm.graduated ? `졸업+${norm.grade}` : String(norm.grade),
            school: s.school || '',
            phone,
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

    // 테이블
    const tbody = document.getElementById('promo-table-body');
    tbody.innerHTML = '';
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="promo-empty">조건에 맞는 학생이 없습니다</td></tr>`;
        document.getElementById('promo-select-all').checked = false;
        return;
    }

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const tr = document.createElement('tr');
        const displayName = r.mergedNames.length > 1 ? r.mergedNames.join(', ') : r.name;
        tr.innerHTML = `
            <td><input type="checkbox" class="promo-row-check" data-idx="${i}" checked></td>
            <td>${escapeHtml(displayName)}</td>
            <td>${escapeHtml(r.level)}</td>
            <td>${escapeHtml(r.grade)}</td>
            <td>${escapeHtml(r.school)}</td>
            <td>${escapeHtml(r.phone)}</td>
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
    // Task 10에서 구현
    alert('Task 10에서 구현 예정');
}

async function handleSheetExport() {
    // Task 11에서 구현
    alert('Task 11에서 구현 예정');
}
