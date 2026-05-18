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

export function pickPrimaryPhone(s) {
    const candidates = [s.parent_phone_1, s.student_phone, s.parent_phone_2];
    for (const phone of candidates) {
        if (phone && String(phone).trim()) return String(phone).trim();
    }
    return null;
}
