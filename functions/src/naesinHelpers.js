// 내신/branch 자동 유도 헬퍼 — student-helpers.js의 핵심 함수 미러.
// Cloud Function에서 자동 정리 시 자동 유도 학생을 정확히 카운트하기 위함.

const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };
// 현재 학부의 학교명 소스. @impact7/shared의 currentSchool과 동일(정규화 없는 raw).
// functions(leave-request)는 @impact7/shared 미의존 → inline 미러.
const SCHOOL_FIELD = { '초등': 'school_elementary', '중등': 'school_middle', '고등': 'school_high' };
function currentSchool(student) {
    return student?.[SCHOOL_FIELD[student?.level]] || '';
}
export const NAESIN_OVERRIDE_EXCLUDE = '';

export function branchFromStudent(s) {
    if (s.branch) return s.branch;
    const regular = (s.enrollments || []).find(
        e => e.class_type === '정규' || e.class_type === '자유학기'
    );
    const cn = regular?.class_number || '';
    const first = cn.trim()[0];
    if (first === '1') return '2단지';
    if (first === '2') return '10단지';
    return '';
}

export function enrollmentCode(e) {
    if (!e) return '';
    return `${e.level_symbol || ''}${e.class_number || ''}`;
}

export function buildNaesinCsKey({ branch, school, level, grade, group }) {
    return `${branch || ''}${school || ''}${level || ''}${grade || ''}${group || ''}`;
}

export function deriveNaesinCode(student, enrollment) {
    const school = currentSchool(student);
    const levelShort = LEVEL_SHORT[student.level] || '';
    const grade = student.grade || '';
    if (!school || !grade) return '';

    const cn = enrollment.class_number || '';
    const lastChar = cn.slice(-1).toUpperCase();

    let group = '';
    if (lastChar === 'A' || lastChar === 'B') {
        group = lastChar;
    } else {
        const lastDigit = parseInt(lastChar);
        if (!isNaN(lastDigit)) group = lastDigit % 2 === 1 ? 'A' : 'B';
    }

    if (!group) {
        const regularEnroll = (student.enrollments || []).find(
            e => (e.class_type === '정규' || e.class_type === '자유학기') && e.class_number
        );
        if (regularEnroll) {
            const regLast = parseInt((regularEnroll.class_number || '').slice(-1));
            if (!isNaN(regLast)) group = regLast % 2 === 1 ? 'A' : 'B';
        }
    }

    return buildNaesinCsKey({ school, level: levelShort, grade, group });
}

export function resolveNaesinCsKey(student, regularEnroll) {
    if (!regularEnroll) return null;
    const override = regularEnroll.naesin_class_override;
    if (typeof override === 'string') {
        return override === NAESIN_OVERRIDE_EXCLUDE ? null : override;
    }
    const nCode = deriveNaesinCode(student, regularEnroll);
    if (!nCode) return null;
    return branchFromStudent(student) + nCode;
}
