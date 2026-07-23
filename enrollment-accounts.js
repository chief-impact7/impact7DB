import {
    accountStateAt,
    accountTypeOf,
    activeEnrollmentsAt,
    closeAccount,
    deriveStudentStatusAfterAccountChange,
    groupEnrollmentAccounts,
    NON_ENROLLABLE_STATUSES,
} from '@impact7/shared/enrollment-status';
import { enrollmentCode } from '@impact7/shared/enrollment-derivation';

const INNER_CLASS_TYPES = new Set(['내신', '자유학기']);
const ACCOUNT_FIELDS = ['account_id', 'account_type', 'pause_start_date', 'pause_end_date', 'leave_sub_type', 'end_reason'];
const STUDENT_END_CLEANUP_FIELDS = [
    'pause_start_date',
    'pause_end_date',
    'withdrawal_date',
    'pre_withdrawal_status',
    'scheduled_leave_status',
];
const ACCOUNT_END_STATUSES = new Set(['퇴원', '종강']);
const cleanupFieldsFor = (status) => ACCOUNT_END_STATUSES.has(status) ? STUDENT_END_CLEANUP_FIELDS : [];

function primaryAccountItem(account) {
    const items = account?.items || [];
    return items.find(item => ['정규', '자유학기', ''].includes(item?.class_type || '')) || items[0];
}

export function accountLabel(account) {
    return [account?.accountType || '정규', enrollmentCode(primaryAccountItem(account) || {})]
        .filter(Boolean)
        .join(' ');
}

export function studentAccounts(student, dateStr) {
    return groupEnrollmentAccounts(student?.enrollments)
        .map(account => {
            const state = accountStateAt(account, dateStr);
            return { ...account, state, label: accountLabel(account) };
        })
        .filter(account => account.state !== '종료');
}

export function activeStudentEnrollments(student, dateStr) {
    return activeEnrollmentsAt(student?.enrollments || [], dateStr);
}

function targetRegular(items, inner) {
    const regulars = items.filter(item =>
        accountTypeOf(item) === '정규'
        && !INNER_CLASS_TYPES.has(item?.class_type)
    );
    const code = enrollmentCode(inner);
    return regulars.find(item => enrollmentCode(item) === code)
        || regulars.find(item => item?.naesin_class_override && item.naesin_class_override === inner?.class_number)
        || (regulars.length === 1 ? regulars[0] : null);
}

export function assignEnrollmentAccounts(enrollments, {
    createId = () => crypto.randomUUID(),
    only,
} = {}) {
    const originals = enrollments || [];
    const assigned = originals.map(item => ({ ...item }));
    const cloneOf = new Map(originals.map((item, index) => [item, assigned[index]]));
    const targets = only ? new Set(only) : new Set(originals);

    for (const original of originals) {
        const item = cloneOf.get(original);
        if (!targets.has(original) || INNER_CLASS_TYPES.has(item?.class_type)) continue;
        if (!item.account_id) item.account_id = createId();
        if (!item.account_type) item.account_type = accountTypeOf(item);
    }

    for (const original of originals) {
        const item = cloneOf.get(original);
        if (!targets.has(original) || !INNER_CLASS_TYPES.has(item?.class_type)) continue;
        if (item.account_id) {
            if (!item.account_type) item.account_type = '정규';
            continue;
        }
        const regularOriginal = targetRegular(originals, original);
        if (!regularOriginal) {
            return {
                enrollments: assigned,
                valid: false,
                reason: `${item.class_type} 수업을 연결할 정규 수강계정이 없습니다.`,
            };
        }
        const regular = cloneOf.get(regularOriginal);
        if (!regular.account_id) regular.account_id = createId();
        if (!regular.account_type) regular.account_type = '정규';
        item.account_id = regular.account_id;
        item.account_type = regular.account_type;
    }

    return { enrollments: assigned, valid: true };
}

export function preserveEnrollmentAccountFields(enrollment, existing) {
    const preserved = { ...enrollment };
    for (const field of ACCOUNT_FIELDS) {
        if (existing?.[field] !== undefined) preserved[field] = existing[field];
    }
    return preserved;
}

function matchingAccount(enrollments, target) {
    const accounts = groupEnrollmentAccounts(enrollments);
    return (typeof target === 'string'
        ? accounts.find(account => account.accountId === target || account.key === target)
        : accounts.find(account => account.items.includes(target))) || null;
}

export function closeStudentAccount(student, target, {
    dateStr,
    endDate = dateStr,
    endReason,
} = {}) {
    const enrollments = student?.enrollments || [];
    const account = matchingAccount(enrollments, target);
    if (!account) return { skipped: true };

    const closed = closeAccount(enrollments, account.key, {
        endDate,
        endReason,
    });
    const status = deriveStudentStatusAfterAccountChange(closed.updatedEnrollments, dateStr, {
        fallbackReason: endReason,
        currentStatus: student.status,
    });
    const cleanupFields = cleanupFieldsFor(status);
    const snapshot = {
        account_id: account.accountId,
        account_type: account.accountType,
        account_key: account.key,
        end_reason: endReason,
        student_status_before: student.status || '',
        student_status_after: status,
    };

    return {
        ...closed,
        account,
        status,
        cleanupFields,
        history: {
            before: JSON.stringify({
                ...snapshot,
                items: account.items,
            }),
            after: JSON.stringify({
                ...snapshot,
                items: closed.removed,
            }),
        },
    };
}

export function closeStudentAccounts(student, targets, options) {
    let current = { ...student, enrollments: student?.enrollments || [] };
    const histories = [];
    const removed = [];

    for (const target of targets || []) {
        const result = closeStudentAccount(current, target, options);
        if (result.skipped) continue;
        histories.push(result.history);
        removed.push(...result.removed);
        current = {
            ...current,
            enrollments: result.updatedEnrollments,
            status: result.status,
        };
    }

    return {
        skipped: histories.length === 0,
        updatedEnrollments: current.enrollments,
        status: current.status,
        cleanupFields: cleanupFieldsFor(current.status),
        histories,
        removed,
    };
}

export function closeExpiredSpecialAccounts(student, dateStr) {
    let current = { ...student, enrollments: student?.enrollments || [] };
    const histories = [];
    const expiredAccounts = groupEnrollmentAccounts(current.enrollments).filter(account =>
        account.accountType === '특강'
        && account.items.every(item =>
            item.end_date
            && /^\d{4}-/.test(item.end_date)
            && item.end_date < dateStr
        )
    );

    for (const account of expiredAccounts) {
        const endDate = account.items
            .map(item => item.end_date)
            .filter(value => value && value < dateStr)
            .sort()
            .at(-1) || dateStr;
        const result = closeStudentAccount(current, account.key, {
            dateStr,
            endDate,
            endReason: '종강',
        });
        if (result.skipped) continue;
        histories.push(result.history);
        current = {
            ...current,
            enrollments: result.updatedEnrollments,
            status: result.status,
        };
    }

    return {
        changed: histories.length > 0,
        enrollments: current.enrollments,
        status: current.status,
        cleanupFields: cleanupFieldsFor(current.status),
        histories,
    };
}

export function accountTarget(account, branch = '') {
    if (!account?.key) return null;
    return {
        account_id: account.key,
        account_type: account.accountType,
        class_code: enrollmentCode(primaryAccountItem(account) || {}),
        class_types: [...new Set(account.items.map(item => item.class_type || '정규'))],
        branch,
        label: accountLabel(account),
    };
}

const targetComparable = target => target && ({
    account_id: target.account_id,
    account_type: target.account_type,
    class_code: target.class_code,
    class_types: target.class_types,
    branch: target.branch,
    label: target.label,
});

export function sameAccountTarget(left, right) {
    return JSON.stringify(targetComparable(left)) === JSON.stringify(targetComparable(right));
}

export function accountTargetExists(student, target) {
    return !!target?.account_id && !!matchingAccount(student?.enrollments, target.account_id);
}

function sameEnrollmentKind(left, right) {
    return (left?.class_type || '정규') === (right?.class_type || '정규')
        && enrollmentCode(left) === enrollmentCode(right);
}

function mergeEnrollment(existing, incoming) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
        if (key === 'day' && Array.isArray(value) && value.length === 0) continue;
        if (value === '' || value === undefined || value === null) continue;
        merged[key] = value;
    }
    return merged;
}

export function mergeImportedEnrollments(existingEnrollments, incomingEnrollments, {
    createId = () => crypto.randomUUID(),
    status,
} = {}) {
    const existing = existingEnrollments || [];
    if (NON_ENROLLABLE_STATUSES.has(status)) {
        return {
            enrollments: [],
            added: [],
            changed: [],
            cleared: existing.length > 0,
            valid: true,
        };
    }
    const incoming = incomingEnrollments || [];
    const incomingSemesters = new Set(incoming.map(item => item.semester).filter(Boolean));
    const hasSemesterData = incomingSemesters.size > 0;
    const kept = hasSemesterData
        ? existing.filter(item => !incomingSemesters.has(item.semester))
        : [];
    const candidates = hasSemesterData
        ? existing.filter(item => incomingSemesters.has(item.semester))
        : existing;
    const used = new Set();
    const bucket = [];
    const added = [];
    const changed = [];

    for (const item of incoming) {
        let matchIndex = -1;
        if (item.account_id) {
            matchIndex = candidates.findIndex((candidate, index) =>
                !used.has(index)
                && candidate.account_id === item.account_id
                && sameEnrollmentKind(candidate, item)
            );
            if (matchIndex < 0) {
                matchIndex = candidates.findIndex((candidate, index) =>
                    !used.has(index)
                    && candidate.account_id === item.account_id
                    && (candidate.class_type || '정규') === (item.class_type || '정규')
                );
            }
        } else {
            matchIndex = candidates.findIndex((candidate, index) =>
                !used.has(index)
                && enrollmentCode(candidate) === enrollmentCode(item)
                && (!hasSemesterData || candidate.semester === item.semester)
            );
        }

        if (matchIndex < 0) {
            bucket.push(item);
            added.push(item);
            continue;
        }

        used.add(matchIndex);
        const merged = mergeEnrollment(candidates[matchIndex], item);
        bucket.push(merged);
        if (JSON.stringify(candidates[matchIndex]) !== JSON.stringify(merged)) changed.push(merged);
    }

    if (!hasSemesterData) {
        candidates.forEach((item, index) => {
            if (!used.has(index)) kept.push(item);
        });
    }

    const combined = [...kept, ...bucket];
    const { enrollments, valid, reason } = assignEnrollmentAccounts(combined, {
        createId,
        only: added,
    });
    return { enrollments, added, changed, cleared: false, valid, reason };
}
