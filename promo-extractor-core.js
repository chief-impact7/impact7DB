export { normalizeRealLevelGrade } from '@impact7/shared/student-label';

export function pickPrimaryPhone(s, fields = ['parent_phone_1', 'student_phone', 'parent_phone_2']) {
    for (const field of fields) {
        const v = s[field];
        if (v && String(v).trim()) return String(v).trim();
    }
    return null;
}

export function gridKeyFor(normalized) {
    if (normalized.graduated) return '졸업';
    return `${normalized.level}${normalized.grade}`;
}

import { branchFromClassNumber } from '@impact7/shared/branch';
export { branchFromClassNumber };

// branchFromStudent: branch 필드가 알려진 단지 값('2단지'|'10단지')일 때만 사용,
// 그 외(비어있거나 의외값)는 첫 enrollment class_number에서 파생.
// shared branchFromStudent는 truthy 체크라 '미지정' 같은 값을 폴백하지 않아 로컬 유지.
export function branchFromStudent(s) {
    if (s.branch === '2단지' || s.branch === '10단지') return s.branch;
    return branchFromClassNumber(s.enrollments?.[0]?.class_number);
}

export function mergeByPhone(rows) {
    const byPhone = new Map();
    const result = [];
    for (const row of rows) {
        if (!row.phone) {
            result.push({ ...row, mergedNames: [row.name] });
            continue;
        }
        if (byPhone.has(row.phone)) {
            byPhone.get(row.phone).mergedNames.push(row.name);
        } else {
            const merged = { ...row, mergedNames: [row.name] };
            byPhone.set(row.phone, merged);
            result.push(merged);
        }
    }
    return result;
}
