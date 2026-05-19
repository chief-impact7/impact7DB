const LEVEL_CUMULATIVE_START = { '초등': 0, '중등': 6, '고등': 9 };

export function normalizeRealLevelGrade(s) {
    const gradeNum = parseInt(s.grade, 10);
    // 학년 미입력은 학부만 반환 — 임의 셀에 배정되지 않도록
    if (isNaN(gradeNum) || gradeNum <= 0) {
        return { level: s.level || '초등', grade: 0, graduated: false };
    }
    const base = LEVEL_CUMULATIVE_START[s.level] ?? 0;
    const cumulative = base + gradeNum;

    if (cumulative <= 6)  return { level: '초등', grade: cumulative,        graduated: false };
    if (cumulative <= 9)  return { level: '중등', grade: cumulative - 6,    graduated: false };
    if (cumulative <= 12) return { level: '고등', grade: cumulative - 9,    graduated: false };
    return { level: '졸업', grade: cumulative - 12, graduated: true };
}

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

// class_number 첫 숫자로 단지 파생: '1xx' → '2단지', '2xx' → '10단지'
export function branchFromClassNumber(num) {
    const first = String(num ?? '').trim().charAt(0);
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
}

// 학생의 단일 소속: branch 필드 우선, 없으면 첫 enrollment의 class_number에서 파생.
// 매칭되는 단지가 없으면 '무소속'.
export function branchFromStudent(s) {
    if (s.branch === '2단지' || s.branch === '10단지') return s.branch;
    return branchFromClassNumber(s.enrollments?.[0]?.class_number) || '무소속';
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
