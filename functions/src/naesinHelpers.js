// 내신/branch 자동 유도 헬퍼 — @impact7/shared 계약의 인라인 미러.
//
// ⚠️  DRIFT 경고: 아래 함수/상수는 @impact7/shared의 대응 심볼과 1:1 미러다.
//     leave-request Cloud Function은 @impact7/shared(프론트엔드 패키지)를 import할 수 없어
//     필요한 로직을 여기에 복사해 둔다.
//
//  미러 대상 (shared → 이 파일):
//    @impact7/shared/student-label :: SCHOOL_FIELD       → SCHOOL_FIELD
//    @impact7/shared/student-label :: currentSchool()    → currentSchool()
//    app.js :: branchFromStudent()                       → branchFromStudent() (export)
//    app.js :: resolveNaesinCsKey()                      → resolveNaesinCsKey() (export)
//
//  유지보수 규칙:
//    shared/student-label.js의 currentSchool·SCHOOL_FIELD 또는
//    app.js의 branchFromStudent·resolveNaesinCsKey 로직이 바뀌면
//    이 파일을 반드시 동기화한다.

const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };
// mirror: @impact7/shared/student-label :: SCHOOL_FIELD
const SCHOOL_FIELD = { '초등': 'school_elementary', '중등': 'school_middle', '고등': 'school_high' };
// mirror: @impact7/shared/student-label :: currentSchool()
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
