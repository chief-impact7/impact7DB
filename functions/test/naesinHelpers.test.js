import { describe, it, expect } from 'vitest';
import {
    branchFromStudent,
    enrollmentCode,
    buildNaesinCsKey,
    deriveNaesinCode,
    resolveNaesinCsKey,
    NAESIN_OVERRIDE_EXCLUDE,
} from '../src/naesinHelpers.js';

// ---------------------------------------------------------------------------
// branchFromStudent
// ---------------------------------------------------------------------------
describe('branchFromStudent', () => {
    it('branch 필드 있으면 그대로 반환', () => {
        const s = { branch: '2단지', enrollments: [{ class_type: '정규', class_number: '201' }] };
        expect(branchFromStudent(s)).toBe('2단지');
    });

    it('정규 enrollment class_number 첫 자리 1 → 2단지', () => {
        const s = {
            enrollments: [
                { class_type: '내신', class_number: '203' }, // index 0이지만 내신
                { class_type: '정규', class_number: '101' },
            ],
        };
        expect(branchFromStudent(s)).toBe('2단지');
    });

    it('정규 enrollment class_number 첫 자리 2 → 10단지', () => {
        const s = {
            enrollments: [
                { class_type: '특강', class_number: '수요특강' }, // index 0이지만 특강
                { class_type: '정규', class_number: '202' },
            ],
        };
        expect(branchFromStudent(s)).toBe('10단지');
    });

    it('자유학기도 정규와 동일하게 처리', () => {
        const s = { enrollments: [{ class_type: '자유학기', class_number: '105' }] };
        expect(branchFromStudent(s)).toBe('2단지');
    });

    it('정규/자유학기 enrollment 없으면 빈 문자열', () => {
        const s = { enrollments: [{ class_type: '특강', class_number: '수요특강' }] };
        expect(branchFromStudent(s)).toBe('');
    });

    it('enrollments 없으면 빈 문자열', () => {
        expect(branchFromStudent({})).toBe('');
        expect(branchFromStudent({ enrollments: [] })).toBe('');
    });

    it('내신만 index 0에 있어도 정규로 branch를 유도한다 (핵심 버그픽스)', () => {
        // 내신이 index 0 → 이전 코드는 내신 class_number로 branch 유도 → 잘못된 결과
        // 수정 후: 정규를 찾아서 유도해야 함
        const s = {
            enrollments: [
                { class_type: '내신', class_number: '211' }, // 2로 시작 → 이전 코드: 10단지(오류)
                { class_type: '정규', class_number: '101' }, // 1로 시작 → 올바른 결과: 2단지
            ],
        };
        expect(branchFromStudent(s)).toBe('2단지');
    });
});

// ---------------------------------------------------------------------------
// enrollmentCode
// ---------------------------------------------------------------------------
describe('enrollmentCode', () => {
    it('level_symbol + class_number 결합', () => {
        expect(enrollmentCode({ level_symbol: 'A', class_number: '101' })).toBe('A101');
        expect(enrollmentCode({ level_symbol: '', class_number: '수요특강' })).toBe('수요특강');
    });

    it('null/undefined → 빈 문자열', () => {
        expect(enrollmentCode(null)).toBe('');
        expect(enrollmentCode(undefined)).toBe('');
    });

    it('필드 누락 시 빈 문자열로 처리', () => {
        expect(enrollmentCode({ class_number: '101' })).toBe('101');
        expect(enrollmentCode({ level_symbol: 'A' })).toBe('A');
    });
});

// ---------------------------------------------------------------------------
// buildNaesinCsKey
// ---------------------------------------------------------------------------
describe('buildNaesinCsKey', () => {
    it('모든 필드 결합', () => {
        expect(buildNaesinCsKey({ branch: '2단지', school: '을지중', level: '중', grade: '2', group: 'A' }))
            .toBe('2단지을지중중2A');
    });

    it('누락 필드는 빈 문자열 처리', () => {
        expect(buildNaesinCsKey({ school: '을지중', level: '중', grade: '2', group: 'B' }))
            .toBe('을지중중2B');
    });
});

// ---------------------------------------------------------------------------
// deriveNaesinCode
// ---------------------------------------------------------------------------
describe('deriveNaesinCode', () => {
    const baseStudent = { school_middle: '을지중', level: '중등', grade: '2', enrollments: [] };

    it('class_number 마지막 자리 홀수 → A 그룹', () => {
        const enrollment = { class_number: '101' };
        expect(deriveNaesinCode(baseStudent, enrollment)).toBe('을지중중2A');
    });

    it('class_number 마지막 자리 짝수 → B 그룹', () => {
        const enrollment = { class_number: '102' };
        expect(deriveNaesinCode(baseStudent, enrollment)).toBe('을지중중2B');
    });

    it('class_number 마지막 자리 A → A 그룹 (명시적)', () => {
        const enrollment = { class_number: '10A' };
        expect(deriveNaesinCode(baseStudent, enrollment)).toBe('을지중중2A');
    });

    it('class_number 마지막 자리 B → B 그룹 (명시적)', () => {
        const enrollment = { class_number: '10B' };
        expect(deriveNaesinCode(baseStudent, enrollment)).toBe('을지중중2B');
    });

    it('마지막 자리로 그룹 판별 불가 시 정규 enrollment 마지막 자리로 fallback', () => {
        const s = {
            ...baseStudent,
            enrollments: [{ class_type: '정규', class_number: '103' }], // 홀수 → A
        };
        const enrollment = { class_number: '내신코드' }; // 마지막 자리 '드' → 숫자/A/B 아님
        expect(deriveNaesinCode(s, enrollment)).toBe('을지중중2A');
    });

    it('현재 학부 학교(currentSchool) 없으면 빈 문자열', () => {
        const s = { ...baseStudent, school_middle: '' };
        expect(deriveNaesinCode(s, { class_number: '101' })).toBe('');
    });

    it('grade 없으면 빈 문자열', () => {
        const s = { ...baseStudent, grade: '' };
        expect(deriveNaesinCode(s, { class_number: '101' })).toBe('');
    });
});

// ---------------------------------------------------------------------------
// resolveNaesinCsKey
// ---------------------------------------------------------------------------
describe('resolveNaesinCsKey', () => {
    const student = { branch: '2단지', school_middle: '을지중', level: '중등', grade: '2', enrollments: [] };

    it('regularEnroll 없으면 null', () => {
        expect(resolveNaesinCsKey(student, null)).toBeNull();
        expect(resolveNaesinCsKey(student, undefined)).toBeNull();
    });

    it('override 빈 문자열(EXCLUDE 센티넬) → null', () => {
        const e = { class_number: '101', naesin_class_override: NAESIN_OVERRIDE_EXCLUDE };
        expect(resolveNaesinCsKey(student, e)).toBeNull();
    });

    it('override 명시적 문자열 → 그대로 반환', () => {
        const e = { class_number: '101', naesin_class_override: '2단지을지중중2B' };
        expect(resolveNaesinCsKey(student, e)).toBe('2단지을지중중2B');
    });

    it('override 없으면 자동 유도 (branch + deriveNaesinCode)', () => {
        const e = { class_number: '101' }; // 홀수 → A
        expect(resolveNaesinCsKey(student, e)).toBe('2단지을지중중2A');
    });

    it('자동 유도 결과가 빈 문자열이면 null', () => {
        const s = { ...student, school_middle: '' }; // 현재 학부 학교 없음 → deriveNaesinCode 빈 문자열
        const e = { class_number: '101' };
        expect(resolveNaesinCsKey(s, e)).toBeNull();
    });
});
