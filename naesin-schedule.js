import { state } from './store.js';
import { showToast } from './toast.js';
import { confirmModal } from './prompt-modal.js';
import { db } from './firebase-config.js';
import { writeBatch, doc, collection, serverTimestamp } from 'firebase/firestore';
import { currentSchool, studentFullLabel } from '@impact7/shared/student-label';

// ===========================================================================
// 내신 시간표 일괄 설정
// ===========================================================================

const NAESIN_DAYS = ['월', '화', '수', '목', '금', '토', '일'];
const NAESIN_ACTIVE_STATUSES = new Set(['재원', '등원예정']);

const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};
const escAttr = (str) => (str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const abbreviateSchool = (s) => studentFullLabel(s) || '';

let _naesinState = { startDate: '', endDate: '', groups: {} };

window.openNaesinSchedule = () => {
    _naesinState = { startDate: '', endDate: '', groups: {} };
    const modal = document.getElementById('naesin-modal');
    modal.style.display = 'flex';
    document.getElementById('naesin-start-date').value = '';
    document.getElementById('naesin-end-date').value = '';
    document.getElementById('naesin-groups').innerHTML =
        '<p style="color:var(--text-sec);font-size:13px;text-align:center;padding:20px 0;">시작일과 종료일을 설정하면 학생 그룹이 표시됩니다.</p>';
    document.getElementById('naesin-start-date').onchange = buildNaesinGroups;
    document.getElementById('naesin-end-date').onchange = buildNaesinGroups;
};

window.closeNaesinSchedule = () => {
    document.getElementById('naesin-modal').style.display = 'none';
};

function buildNaesinGroups() {
    const startDate = document.getElementById('naesin-start-date').value;
    const endDate = document.getElementById('naesin-end-date').value;
    if (!startDate || !endDate) return;
    _naesinState.startDate = startDate;
    _naesinState.endDate = endDate;

    const targets = state.allStudents.filter(s =>
        NAESIN_ACTIVE_STATUSES.has(s.status || '재원') &&
        (s.level === '중등' || s.level === '고등')
    );

    const groupMap = {};
    for (const s of targets) {
        const school = currentSchool(s) || '학교미입력';
        const grade = s.grade || '?';
        const key = `${school}_${s.level}_${grade}`;
        const label = abbreviateSchool(s) || `${school}_${s.level}_${grade}`;
        if (!groupMap[key]) groupMap[key] = { label, students: [] };
        groupMap[key].students.push(s);
    }

    const sortedKeys = Object.keys(groupMap).sort((a, b) => groupMap[b].students.length - groupMap[a].students.length);

    _naesinState.groups = {};
    for (const key of sortedKeys) {
        const g = groupMap[key];
        _naesinState.groups[key] = {
            label: g.label,
            subgroups: [{ days: [], time: '', studentIds: g.students.map(s => s.id) }],
            overrides: {},
        };
    }

    renderNaesinGroups();
}

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

        const ek = escAttr(key);
        return `<div class="naesin-group" data-key="${ek}">
            <div class="naesin-group-header" onclick="this.parentElement.classList.toggle('collapsed')">
                <h4>${esc(g.label)}</h4>
                <span class="count">${totalStudents}명${overrideCount ? ` (예외 ${overrideCount})` : ''}</span>
            </div>
            <div class="naesin-group-body">
                ${g.subgroups.map((sg, si) => renderNaesinSubgroup(key, sg, si, g)).join('')}
                <span class="naesin-add-subgroup" onclick="window.addNaesinSubgroup('${ek}')">
                    <span class="material-symbols-outlined" style="font-size:14px;">add</span> 서브그룹 추가
                </span>
            </div>
        </div>`;
    }).join('');
}

function renderNaesinSubgroup(groupKey, sg, subIdx, group) {
    const ek = escAttr(groupKey);
    const dayChecks = NAESIN_DAYS.map(d => {
        const checked = sg.days.includes(d) ? 'checked' : '';
        return `<label><input type="checkbox" value="${d}" ${checked}
            onchange="window.updateNaesinSubDays('${ek}',${subIdx})"><span>${d}</span></label>`;
    }).join('');

    const students = sg.studentIds.map(id => {
        const s = state.allStudents.find(st => st.id === id);
        if (!s) return '';
        const hasOverride = !!group.overrides[id];
        const cls = hasOverride ? 'naesin-chip override' : 'naesin-chip';
        const overrideInfo = hasOverride
            ? ` title="${escAttr(group.overrides[id].days.join(''))} ${escAttr(group.overrides[id].time)}"`
            : '';
        return `<span class="${cls}" data-id="${escAttr(id)}"${overrideInfo}
            onclick="window.openNaesinOverride(event,'${ek}',${subIdx},'${escAttr(id)}')">${esc(s.name)}</span>`;
    }).join('');

    const removeBtn = subIdx > 0
        ? `<span class="naesin-remove-sub material-symbols-outlined" onclick="window.removeNaesinSubgroup('${ek}',${subIdx})" title="삭제">close</span>`
        : '';

    return `<div class="naesin-subgroup" data-sub="${subIdx}">
        <div class="naesin-subgroup-controls">
            <div class="naesin-day-checks">${dayChecks}</div>
            <input type="time" class="naesin-time-input" value="${escAttr(sg.time)}"
                onchange="window.updateNaesinSubTime('${ek}',${subIdx},this.value)">
            ${removeBtn}
        </div>
        <div class="naesin-students">${students || '<span style="color:var(--text-sec);font-size:12px;">학생 없음</span>'}</div>
    </div>`;
}

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
    const removed = g.subgroups.splice(subIdx, 1)[0];
    g.subgroups[0].studentIds.push(...removed.studentIds);
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

// ---------------------------------------------------------------------------
// 학생 클릭 → 서브그룹 이동 또는 개별 예외 설정
// ---------------------------------------------------------------------------
window.openNaesinOverride = (event, groupKey, subIdx, studentId) => {
    event.stopPropagation();
    document.querySelectorAll('.naesin-override-popup').forEach(el => el.remove());

    const g = _naesinState.groups[groupKey];
    if (!g) return;
    const s = state.allStudents.find(st => st.id === studentId);
    if (!s) return;

    const existingOverride = g.overrides[studentId];
    const popup = document.createElement('div');
    popup.className = 'naesin-override-popup';

    const ek = escAttr(groupKey);
    const eid = escAttr(studentId);
    const moveOptions = g.subgroups.map((sg, i) => {
        if (i === subIdx) return '';
        const label = sg.days.length > 0 ? `${sg.days.join('')} ${sg.time || ''}` : `서브그룹 ${i + 1}`;
        return `<button class="btn-cancel" style="font-size:12px;padding:4px 8px;" onclick="window.moveNaesinStudent('${ek}',${subIdx},${i},'${eid}')">→ ${esc(label)}</button>`;
    }).filter(Boolean).join('');

    const ovDays = existingOverride ? existingOverride.days : g.subgroups[subIdx].days;
    const ovTime = existingOverride ? existingOverride.time : g.subgroups[subIdx].time;
    const dayChecks = NAESIN_DAYS.map(d =>
        `<label style="font-size:12px;"><input type="checkbox" value="${d}" ${ovDays.includes(d) ? 'checked' : ''}><span>${d}</span></label>`
    ).join(' ');

    popup.innerHTML = `
        <label>${esc(s.name)} — 개별 설정</label>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${dayChecks}</div>
        <input type="time" class="naesin-time-input" value="${escAttr(ovTime)}" style="width:100px;">
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button class="btn-save" style="font-size:12px;padding:4px 10px;" onclick="window.applyNaesinOverride('${ek}','${eid}',this)">적용</button>
            ${existingOverride ? `<button class="btn-cancel" style="font-size:12px;padding:4px 10px;" onclick="window.clearNaesinOverride('${ek}','${eid}')">예외 해제</button>` : ''}
        </div>
        ${g.subgroups.length > 1 ? `<hr style="margin:4px 0;border:none;border-top:1px solid var(--border);"><label>서브그룹 이동</label>${moveOptions}` : ''}
    `;

    const chip = event.target;
    const rect = chip.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
    document.body.appendChild(popup);
    const popupH = popup.offsetHeight;
    popup.style.top = (rect.bottom + 4 + popupH > window.innerHeight)
        ? Math.max(4, rect.top - popupH - 4) + 'px'
        : (rect.bottom + 4) + 'px';

    const closeHandler = (e) => {
        if (!popup.contains(e.target) && e.target !== chip) {
            popup.remove();
            document.removeEventListener('mousedown', closeHandler);
        }
    };
    const observer = new MutationObserver(() => {
        if (!document.body.contains(popup)) {
            document.removeEventListener('mousedown', closeHandler);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
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
    if (days.length === 0) { showToast('요일을 선택해주세요.', 'warn'); return; }
    _naesinState.groups[groupKey].overrides[studentId] = { days, time };
    popup.remove();
    renderNaesinGroups();
};

window.clearNaesinOverride = (groupKey, studentId) => {
    delete _naesinState.groups[groupKey].overrides[studentId];
    document.querySelectorAll('.naesin-override-popup').forEach(el => el.remove());
    renderNaesinGroups();
};

// ---------------------------------------------------------------------------
// 내신 시간표 저장 (Firestore batch write)
// ---------------------------------------------------------------------------
window.saveNaesinSchedule = async () => {
    const { startDate, endDate, groups } = _naesinState;
    if (!startDate || !endDate) { showToast('내신 기간을 설정해주세요.', 'warn'); return; }
    if (endDate <= startDate) { showToast('종료일은 시작일 이후여야 합니다.', 'warn'); return; }

    const studentMap = new Map(state.allStudents.map(s => [s.id, s]));
    const writes = [];
    const dayWarnings = [];
    const timeWarnings = [];

    for (const [, g] of Object.entries(groups)) {
        for (const sg of g.subgroups) {
            for (const id of sg.studentIds) {
                const override = g.overrides[id];
                const days = override ? override.days : sg.days;
                const time = override ? override.time : sg.time;
                const name = studentMap.get(id)?.name || id;

                if (days.length === 0) {
                    dayWarnings.push(name);
                    continue;
                }
                // 등원시간 누락 시 학생 카드에 정확한 시간이 안 보임 → 등원지연/혼선 원인.
                if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
                    timeWarnings.push(name);
                    continue;
                }
                writes.push({ studentId: id, days, time });
            }
        }
    }

    if (dayWarnings.length > 0) {
        showToast(`요일 미설정 학생이 있습니다:\n${dayWarnings.join(', ')}\n\n요일을 설정하거나 서브그룹에서 제외해주세요.`, 'warn', { sticky: true });
        return;
    }
    if (timeWarnings.length > 0) {
        showToast(`등원시간 미입력 학생이 있습니다:\n${timeWarnings.join(', ')}\n\n해당 서브그룹의 시간을 입력하거나 학생을 제외해주세요.`, 'warn', { sticky: true });
        return;
    }

    if (writes.length === 0) { showToast('저장할 학생이 없습니다.', 'warn'); return; }

    const conflicts = [];
    for (const w of writes) {
        const s = studentMap.get(w.studentId);
        if (!s) continue;
        const hasNaesin = (s.enrollments || []).some(e =>
            e.class_type === '내신' &&
            e.start_date === startDate && e.end_date === endDate
        );
        if (hasNaesin) conflicts.push(s.name);
    }
    if (conflicts.length > 0) {
        if (!(await confirmModal({ title: '기존 내신 덮어쓰기', message: `다음 학생에 동일 기간 내신이 이미 있습니다:\n${conflicts.join(', ')}\n\n기존 내신을 덮어쓰시겠습니까?`, confirmText: '덮어쓰기' }))) return;
    }

    if (!(await confirmModal({ title: '내신 시간표 적용', message: `${writes.length}명에게 내신 시간표를 적용합니다.\n기간: ${startDate} ~ ${endDate}`, confirmText: '적용' }))) return;

    const saveBtn = document.getElementById('naesin-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = '저장 중...';
    const naesinOverlay = document.getElementById('naesin-modal');
    if (naesinOverlay) naesinOverlay.dataset.busy = '1';

    try {
        const filterSemester = state.activeFilters.semester || '';
        const BATCH_SIZE = 200;

        for (let i = 0; i < writes.length; i += BATCH_SIZE) {
            const chunk = writes.slice(i, i + BATCH_SIZE);
            const batch = writeBatch(db);

            for (const w of chunk) {
                const s = studentMap.get(w.studentId);
                if (!s) continue;

                const semester = filterSemester || state.currentSemesterByLevel[s.level] || '';
                const newEnrollment = {
                    class_type: '내신',
                    day: w.days,
                    start_time: w.time,
                    start_date: startDate,
                    end_date: endDate,
                    class_number: '',
                    level_symbol: '',
                    semester,
                };

                let enrollments = [...(s.enrollments || [])];
                const existIdx = enrollments.findIndex(e =>
                    e.class_type === '내신' && e.start_date === startDate && e.end_date === endDate
                );
                if (existIdx >= 0) {
                    enrollments[existIdx] = newEnrollment;
                } else {
                    enrollments.push(newEnrollment);
                }

                batch.update(doc(db, 'students', w.studentId), { enrollments, updated_at: serverTimestamp() });
                const historyRef = doc(collection(db, 'history_logs'));
                batch.set(historyRef, {
                    doc_id: w.studentId,
                    change_type: 'UPDATE',
                    before: '—',
                    after: `내신 추가: ${w.days.join('')} ${w.time} (${startDate}~${endDate}) (내신일괄설정)`,
                    google_login_id: state.currentUser?.email || '—',
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

        window.dispatchEvent(new CustomEvent('impact7:studentsChanged'));
        window.closeNaesinSchedule();
        showToast(`${writes.length}명의 내신 시간표를 저장했습니다.`, 'success');
    } catch (e) {
        console.error('[NAESIN SAVE ERROR]', e);
        showToast('내신 시간표 저장 실패: ' + e.message, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
        if (naesinOverlay) delete naesinOverlay.dataset.busy;
    }
};
