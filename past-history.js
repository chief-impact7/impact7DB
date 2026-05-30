/**
 * past-history.js — "이전 학원생활" 뷰
 *
 * 비활성(퇴원/종강/상담 등) 학생을 선택했을 때 우측 패널 전체를 교체하는
 * 과거이력 단일 뷰. 다음 3개 섹션을 표시한다:
 *
 *   A. 과거 수업/반 이력 — enrollments 중 만료된 항목 + history_logs 종강 로그
 *   B. 휴원/퇴원 사이클 — leave_requests 를 사이클 단위로 묶어 표시
 *   C. 헤더 — 이름, 학교, 학년, 현재 상태, 첫 등록일, 마지막 활동일
 *
 * 활성 학생(재원/등원예정/실휴원/가휴원)에는 영향을 주지 않는다.
 * 분기 진입은 app.js:selectStudent 에서 PAST_HISTORY_VIEW 모드로 처리.
 *
 * 모듈 분리 규칙(AGENTS.md):
 *   - 공유 상태는 store.js 에서만 import (직접 mutate 금지)
 *   - 헬퍼는 app.js 의 export 재사용 (enrollmentCode, formatDate,
 *     fetchStudentLeaveRequests)
 */

import { state } from './store.js';
import { db } from './firebase-config.js';
import { currentSchool } from '@impact7/shared/student-label';
import { collection, query, where, orderBy, getDocs, doc, getDoc } from 'firebase/firestore';
import {
    enrollmentCode,
    formatDate,
    fetchStudentLeaveRequests,
} from './app.js';

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

// 활성 상태 (DSC 미러 시 동일 정의 유지) — app.js 의 ACTIVE_STUDENT_STATUSES 와 동기.
// app.js 가 분기 책임을 지지만, DSC 미러나 모듈 단독 사용을 대비해 같은 셋을 export.
export const ACTIVE_STATES = new Set(['재원', '등원예정', '실휴원', '가휴원']);
export const isActiveStudent = (student) => ACTIVE_STATES.has(student?.status || '');

// 휴원 사이클 식별용 request_type 셋
const LEAVE_START_TYPES = new Set(['휴원요청', '퇴원→휴원']);
const LEAVE_EXTEND_TYPES = new Set(['휴원연장']);
const RETURN_TYPES = new Set(['복귀요청', '재등원요청']);
const WITHDRAW_TYPES = new Set(['퇴원요청', '휴원→퇴원']);

// 사이클 카드 라벨 — 첫 요청 타입을 기준으로 묶음
const CYCLE_LABEL = {
    leave: { label: '휴원', color: '#2563eb', bg: '#dbeafe' },
    leave_to_withdraw: { label: '휴→퇴', color: '#dc2626', bg: '#fee2e2' },
    withdraw: { label: '퇴원', color: '#dc2626', bg: '#fee2e2' },
};

const REQUEST_STATUS_LABEL = {
    approved: '승인',
    cancelled: '취소',
    rejected: '반려',
};

// ---------------------------------------------------------------------------
// HTML 이스케이프 (app.js 와 별개로 모듈 내부 헬퍼)
// ---------------------------------------------------------------------------

const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};

// ---------------------------------------------------------------------------
// 데이터 수집 헬퍼
// ---------------------------------------------------------------------------

/**
 * student.enrollments[] 중 "과거"로 분류할 수 있는 항목을 시기순(최신 → 과거)으로 정렬해 반환.
 * 기준:
 *   - end_date 가 유효하고 오늘 이전 → 과거
 *   - class_type 이 정규가 아니고 end_date 가 있는데 만료 → 과거 (위 케이스 포함)
 *   - 정규(end_date 없는 게 일반)은 enrollments 에 안 남아있을 수 있어 history_logs 로 보강 (별도 함수)
 */
function getPastEnrollmentsFromArray(student) {
    const today = new Date().toISOString().slice(0, 10);
    const enrollments = student.enrollments || [];
    return enrollments
        .filter(e => e.end_date && /^\d{4}-/.test(e.end_date) && e.end_date < today)
        .slice()
        .sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''));
}

/**
 * history_logs 에서 "종강 처리: <CODE> (정규)" 패턴을 파싱해 정규 종강 이력을 복원.
 * after 텍스트에 "종강 처리:" 가 포함된 로그를 모두 찾는다 (개별/전체 종강 모두).
 * 같은 코드가 여러 번 잡힐 수 있어 timestamp 가장 최근 1건만 남긴다.
 */
function parseRegularEndingsFromLogs(logs) {
    const byCode = new Map();
    const re = /종강 처리:\s*([A-Z]+\d+)\s*\(정규\)/g;
    for (const log of logs) {
        const after = typeof log.after === 'string' ? log.after : '';
        if (!after.includes('종강 처리')) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(after)) !== null) {
            const code = m[1];
            const ts = log.timestamp?.toDate ? log.timestamp.toDate() : null;
            const existing = byCode.get(code);
            if (!existing || (ts && ts > existing.endTs)) {
                byCode.set(code, {
                    code,
                    class_type: '정규',
                    end_date: ts ? toDateStr(ts) : null,
                    endTs: ts,
                    source: 'history_logs',
                    log_id: log.id,
                });
            }
        }
    }
    return Array.from(byCode.values()).sort((a, b) => {
        const ad = a.end_date || '';
        const bd = b.end_date || '';
        return bd.localeCompare(ad);
    });
}

function toDateStr(d) {
    if (!d) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * 학생의 모든 history_logs 를 timestamp DESC 로 조회.
 * loadHistory 와 동일 쿼리지만 캐싱 없이 매번 다시 읽는다 (드물게 호출되는 뷰라 OK).
 */
async function fetchStudentHistoryLogs(studentId) {
    try {
        const q = query(
            collection(db, 'history_logs'),
            where('doc_id', '==', studentId),
            orderBy('timestamp', 'desc'),
        );
        const snap = await getDocs(q);
        const logs = [];
        snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
        return logs;
    } catch (e) {
        console.error('[past-history] fetchStudentHistoryLogs:', e);
        return [];
    }
}

/**
 * class_settings/{code} doc 에서 teacher 이메일을 읽고, teachers/{email}.display_name 으로 매핑.
 * 못 찾으면 null 반환. 실패해도 throw 하지 않는다.
 *
 * 주의: 과거 시점이 아니라 현재 시점 lookup 이다 (변경 이력 미기록).
 */
async function lookupCurrentTeacher(code) {
    if (!code) return null;
    try {
        const csSnap = await getDoc(doc(db, 'class_settings', code));
        if (!csSnap.exists()) return null;
        const email = (csSnap.data() || {}).teacher;
        if (!email) return null;
        const fallback = email.split('@')[0] || email;
        const tSnap = await getDoc(doc(db, 'teachers', email));
        if (!tSnap.exists()) return fallback;
        return (tSnap.data() || {}).display_name || fallback;
    } catch (e) {
        console.warn('[past-history] lookupCurrentTeacher failed for', code, e);
        return null;
    }
}

// ---------------------------------------------------------------------------
// 휴원/퇴원 사이클 묶음 알고리즘
// ---------------------------------------------------------------------------

/**
 * leave_requests 를 시간순 (오래된 순) 으로 정렬한 뒤,
 * 휴원 사이클 = 시작 + (연장 N개) + 종료(복귀/휴→퇴) 로 묶고,
 * 퇴원 사이클 = 단일 퇴원요청을 그대로 1개 카드로 만든다.
 *
 * 단순화: 한 번 시작된 사이클은 다음 시작 요청을 만나거나 종료 요청을 만나면 닫는다.
 *
 * 정책 (DSC 와 통일, 05_qa_report.md §4 권장):
 *   • cancelled/rejected 는 제외 (취소된 요청은 발생하지 않은 사건)
 *   • consultation_note 는 누적 + prefix 방식으로 합쳐 줄바꿈 표시
 *       - 첫 요청: 노트 그대로
 *       - 휴원연장: [연장] {note}
 *       - 복귀요청: [복귀] {note}
 *       - 휴원→퇴원: [퇴원전환] {note}
 *
 * 반환: { type, startDate, endDate, requests: [r,...], summary } 배열
 */
function groupLeaveRequestsIntoCycles(requests) {
    // WARN-5: cancelled/rejected 제외 (DSC 와 통일)
    const filtered = (requests || []).filter(r => r.status !== 'cancelled' && r.status !== 'rejected');

    const sortKey = (r) => r.leave_start_date || r.requested_at?.toDate?.()?.toISOString() || '';
    const sorted = [...filtered].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

    // WARN-7: prefix 누적 헬퍼
    const appendNote = (current, prefix, note) => {
        if (!note) return;
        const tagged = prefix ? `[${prefix}] ${note}` : note;
        current.lastNote = current.lastNote ? `${current.lastNote}\n${tagged}` : tagged;
    };

    const cycles = [];
    let current = null;

    const closeCurrent = () => {
        if (current) {
            cycles.push(current);
            current = null;
        }
    };
    const startLeaveCycle = (r) => {
        closeCurrent();
        current = {
            type: 'leave',
            requests: [r],
            startDate: r.leave_start_date || null,
            endDate: r.leave_end_date || null,
            lastNote: r.consultation_note || '',
        };
    };

    for (const r of sorted) {
        const t = r.request_type;

        if (LEAVE_START_TYPES.has(t)) {
            // 새 휴원 사이클 시작 — 진행 중인 사이클이 있으면 닫는다
            startLeaveCycle(r);
        } else if (LEAVE_EXTEND_TYPES.has(t)) {
            // 연장: 진행 중이면 흡수, 아니면 단독 사이클로 시작
            if (!current || current.type !== 'leave') {
                startLeaveCycle(r);
            } else {
                current.requests.push(r);
                current.endDate = r.leave_end_date || current.endDate;
                appendNote(current, '연장', r.consultation_note);
            }
        } else if (RETURN_TYPES.has(t)) {
            // 복귀: 진행 중이면 닫고 endDate 를 복귀일로
            if (current) {
                current.requests.push(r);
                current.endDate = r.return_date || current.endDate;
                appendNote(current, '복귀', r.consultation_note);
                closeCurrent();
            } else {
                // 사이클 없이 복귀가 단독으로 있을 수 있음 (드물게) — 단독 카드
                cycles.push({
                    type: 'return_only',
                    requests: [r],
                    startDate: r.return_date || null,
                    endDate: r.return_date || null,
                    lastNote: r.consultation_note || '',
                });
            }
        } else if (WITHDRAW_TYPES.has(t)) {
            // 퇴원: 진행 중인 휴원 사이클이 있으면 휴→퇴로 닫고, 없으면 단독 퇴원 카드
            if (current && current.type === 'leave') {
                current.requests.push(r);
                current.endDate = r.withdrawal_date || current.endDate;
                current.type = 'leave_to_withdraw';
                appendNote(current, '퇴원전환', r.consultation_note);
                closeCurrent();
            } else {
                closeCurrent();
                cycles.push({
                    type: 'withdraw',
                    requests: [r],
                    startDate: r.withdrawal_date || null,
                    endDate: r.withdrawal_date || null,
                    lastNote: r.consultation_note || '',
                });
            }
        } else {
            // 알 수 없는 타입 — 단독 카드로 그대로 노출
            closeCurrent();
            cycles.push({
                type: 'other',
                requests: [r],
                startDate: r.leave_start_date || r.withdrawal_date || r.return_date || null,
                endDate: r.leave_end_date || r.withdrawal_date || r.return_date || null,
                lastNote: r.consultation_note || '',
            });
        }
    }
    closeCurrent();

    // 최신이 위로
    return cycles.slice().reverse();
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------

function renderHeaderSection(student, lastActivityDate) {
    const status = student.status || '—';
    const firstReg = student.first_registered ? formatDate(student.first_registered) : '—';
    const last = lastActivityDate ? formatDate(lastActivityDate) : '—';
    const initial = (student.name || '?')[0];

    return `
        <div class="past-history-header">
            <div class="past-history-avatar"><span>${esc(initial)}</span></div>
            <div class="past-history-header-meta">
                <h2 class="past-history-name">${esc(student.name || '—')}</h2>
                <div class="past-history-tags">
                    <span class="tag">${esc(currentSchool(student) || '학교 미입력')}</span>
                    ${student.grade ? `<span class="tag">${esc(student.grade)}학년</span>` : ''}
                    ${student.level ? `<span class="tag">${esc(student.level)}</span>` : ''}
                    <span class="tag tag-status past-history-status-tag">${esc(status)}</span>
                </div>
                <div class="past-history-meta-row">
                    <span class="past-history-meta-item">
                        <span class="material-symbols-outlined" aria-hidden="true">event_available</span>
                        첫 등록: ${esc(firstReg)}
                    </span>
                    <span class="past-history-meta-item">
                        <span class="material-symbols-outlined" aria-hidden="true">update</span>
                        마지막 활동: ${esc(last)}
                    </span>
                </div>
            </div>
        </div>
    `;
}

function renderEnrollmentCard(item, teacherName) {
    const code = item.code || enrollmentCode(item);
    const ct = item.class_type || '정규';
    const start = item.start_date ? formatDate(item.start_date) : '—';
    const end = item.end_date ? formatDate(item.end_date) : '—';
    const semester = item.semester || '—';
    const sourceTag = item.source === 'history_logs'
        ? '<span class="past-enrollment-source" title="정규는 종강 시 enrollments에서 제거되어 history_logs로 복원">log</span>'
        : '';
    return `
        <div class="past-enrollment-card">
            <div class="past-enrollment-card-head">
                <span class="past-enrollment-code">${esc(code || '—')}</span>
                <span class="past-enrollment-type past-enrollment-type-${esc(ct)}">${esc(ct)}</span>
                ${sourceTag}
                <span class="past-enrollment-semester">${esc(semester)}</span>
            </div>
            <div class="past-enrollment-card-body">
                <div class="past-enrollment-period">
                    <span class="material-symbols-outlined" aria-hidden="true">date_range</span>
                    ${esc(start)} ~ ${esc(end)}
                </div>
                <div class="past-enrollment-teacher">
                    <span class="material-symbols-outlined" aria-hidden="true">person</span>
                    담당: ${teacherName ? esc(teacherName) : '<span class="past-history-muted">—</span>'}
                </div>
            </div>
        </div>
    `;
}

function renderCycleCard(cycle) {
    const labelMeta = CYCLE_LABEL[cycle.type] || { label: cycle.type || '기타', color: '#6b7280', bg: '#f3f4f6' };
    const start = cycle.startDate ? formatDate(cycle.startDate) : '—';
    const end = cycle.endDate ? formatDate(cycle.endDate) : '—';
    const note = cycle.lastNote || '';

    // 사이클 안의 요청들 간단 요약
    const reqLines = cycle.requests.map(r => {
        const t = r.request_type || '';
        const d = r.leave_start_date || r.return_date || r.withdrawal_date || '';
        const status = REQUEST_STATUS_LABEL[r.status] || '진행중';
        return `<li><span class="past-cycle-req-type">${esc(t)}</span> <span class="past-cycle-req-date">${esc(formatDate(d))}</span> <span class="past-cycle-req-status">${esc(status)}</span></li>`;
    }).join('');

    return `
        <div class="past-cycle-card">
            <div class="past-cycle-card-head">
                <span class="past-cycle-badge" style="background:${labelMeta.bg};color:${labelMeta.color};">${esc(labelMeta.label)}</span>
                <span class="past-cycle-period">${esc(start)} ~ ${esc(end)}</span>
            </div>
            ${note ? `<div class="past-cycle-note">${esc(note).replace(/\n/g, '<br>')}</div>` : ''}
            <details class="past-cycle-details">
                <summary>요청 내역 ${cycle.requests.length}건</summary>
                <ul class="past-cycle-req-list">${reqLines}</ul>
            </details>
        </div>
    `;
}

function renderEmpty(message) {
    return `<div class="past-history-empty">${esc(message)}</div>`;
}

// ---------------------------------------------------------------------------
// 진입점: 우측 패널을 과거이력 뷰로 채운다
// ---------------------------------------------------------------------------

export async function renderPastHistory(student) {
    if (!student) return;
    const studentId = student.id || state.currentStudentId;

    const container = document.getElementById('past-history-view');
    if (!container) {
        console.warn('[past-history] #past-history-view container missing');
        return;
    }
    container.style.display = 'block';
    container.innerHTML = `
        <div class="past-history-content">
            <div class="past-history-loading">과거 이력을 불러오는 중...</div>
        </div>
    `;

    // 1) history_logs 와 leave_requests 병렬 조회
    let logs = [];
    let leaveReqs = [];
    try {
        [logs, leaveReqs] = await Promise.all([
            fetchStudentHistoryLogs(studentId),
            fetchStudentLeaveRequests(studentId),
        ]);
    } catch (e) {
        console.error('[past-history] fetch failed:', e);
    }

    // 학생이 바뀌었으면 렌더 중단 (사용자가 다른 학생을 클릭한 경우)
    if (state.currentStudentId !== studentId) return;

    // 2) 과거 수업/반 이력 구성
    //    - enrollments[] 에 남아있는 만료 항목 (내신/특강 등)
    //    - history_logs 에서 파싱한 정규 종강 (enrollments 에서 제거됨)
    //    같은 (code, end_date) 가 양쪽에 있으면 enrollments 쪽을 우선.
    const arrayPast = getPastEnrollmentsFromArray(student).map(e => ({
        code: enrollmentCode(e),
        class_type: e.class_type || '정규',
        start_date: e.start_date || null,
        end_date: e.end_date || null,
        semester: e.semester || null,
        source: 'enrollments',
    }));
    const keyOf = (e) => `${e.code}|${e.end_date || ''}`;
    const seen = new Set(arrayPast.map(keyOf));
    const merged = [...arrayPast];
    for (const e of parseRegularEndingsFromLogs(logs)) {
        const k = keyOf(e);
        if (seen.has(k)) continue;
        merged.push(e);
        seen.add(k);
    }
    merged.sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''));

    // 3) 사이클 묶음
    const cycles = groupLeaveRequestsIntoCycles(leaveReqs);

    // 4) 마지막 활동일 — 통일된 공통 정책 (05_qa_report.md §4 권장):
    //    max(status_changed_at, 가장 최신 history_log.timestamp,
    //        enrollments 모든 end_date, leave_requests 모든 일자)
    //    모든 후보를 ms 단위 timestamp 로 정규화한 뒤 최대값을 ISO date(yyyy-mm-dd)로 환산.
    const toMs = (v) => {
        if (!v) return 0;
        if (typeof v?.toDate === 'function') {
            const d = v.toDate();
            return d ? d.getTime() : 0;
        }
        if (v instanceof Date) return v.getTime();
        if (typeof v === 'string') {
            const t = new Date(v).getTime();
            return Number.isFinite(t) ? t : 0;
        }
        return 0;
    };

    const candidatesMs = [];
    candidatesMs.push(toMs(student.status_changed_at));
    for (const log of logs) candidatesMs.push(toMs(log.timestamp));
    for (const e of (student.enrollments || [])) {
        candidatesMs.push(toMs(e.end_date));
    }
    for (const r of leaveReqs) {
        candidatesMs.push(toMs(r.leave_start_date));
        candidatesMs.push(toMs(r.leave_end_date));
        candidatesMs.push(toMs(r.return_date));
        candidatesMs.push(toMs(r.withdrawal_date));
        candidatesMs.push(toMs(r.requested_at));
        candidatesMs.push(toMs(r.created_at));
    }
    const maxMs = candidatesMs.reduce((a, b) => (b > a ? b : a), 0);
    const lastActivity = maxMs > 0 ? toDateStr(new Date(maxMs)) : null;

    // 5) 담당 선생 lookup (각 코드별로 1번씩, 캐싱)
    const codes = Array.from(new Set(merged.map(e => e.code).filter(Boolean)));
    const teacherCache = {};
    await Promise.all(codes.map(async (code) => {
        teacherCache[code] = await lookupCurrentTeacher(code);
    }));

    // 학생 변경 재확인
    if (state.currentStudentId !== studentId) return;

    // 6) 최종 HTML 조립
    const headerHtml = renderHeaderSection(student, lastActivity);

    const enrollmentSection = merged.length === 0
        ? renderEmpty('과거 수업 이력이 없습니다.')
        : merged.map(item => renderEnrollmentCard(item, teacherCache[item.code])).join('');

    const cycleSection = cycles.length === 0
        ? renderEmpty('휴원/퇴원 요청 이력이 없습니다.')
        : cycles.map(renderCycleCard).join('');

    container.innerHTML = `
        <div class="past-history-content">
            ${headerHtml}

            <section class="past-history-section">
                <h3 class="past-history-section-title">
                    <span class="material-symbols-outlined" aria-hidden="true">history_edu</span>
                    과거 수업·반 이력
                </h3>
                <div class="past-enrollment-list">${enrollmentSection}</div>
            </section>

            <section class="past-history-section">
                <h3 class="past-history-section-title">
                    <span class="material-symbols-outlined" aria-hidden="true">event_busy</span>
                    휴원·퇴원 사이클
                </h3>
                <div class="past-cycle-list">${cycleSection}</div>
            </section>
        </div>
    `;
}

// HTML 에서 호출 가능하도록 window 노출
window.renderPastHistory = renderPastHistory;
window.isActiveStudent = isActiveStudent;
