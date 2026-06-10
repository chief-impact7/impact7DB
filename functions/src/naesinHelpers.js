// 내신/branch 자동 유도 헬퍼
//
// SCHOOL_FIELD·currentSchool·LEVEL_SHORT → @impact7/shared/student-label
// enrollmentCode                          → @impact7/shared/enrollment-derivation (re-export)
// branchFromStudent 내부 매핑             → @impact7/shared/branch branchFromClassNumber 위임

import { SCHOOL_FIELD, LEVEL_SHORT, currentSchool as _currentSchool } from '@impact7/shared/student-label';
import { enrollmentCode as _enrollmentCode } from '@impact7/shared/enrollment-derivation';
import { branchFromClassNumber } from '@impact7/shared/branch';

export { SCHOOL_FIELD, LEVEL_SHORT };
export const NAESIN_OVERRIDE_EXCLUDE = '';

// re-export: dailyStats.js·cleanup.js가 이 파일에서 import
// null/undefined 가드: 미러 원본 동작 유지 (shared enrollmentCode는 null 비가드)
export const enrollmentCode = (e) => e ? _enrollmentCode(e) : '';

export function branchFromStudent(s) {
    if (s.branch) return s.branch;
    const regular = (s.enrollments || []).find(
        e => e.class_type === '정규' || e.class_type === '자유학기'
    );
    return branchFromClassNumber(regular?.class_number || '');
}

export function buildNaesinCsKey({ branch, school, level, grade, group }) {
    return `${branch || ''}${school || ''}${level || ''}${grade || ''}${group || ''}`;
}

export function deriveNaesinCode(student, enrollment) {
    const school = _currentSchool(student);
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
