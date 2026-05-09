import { describe, it, expect } from 'vitest';
import { _internals, runClassCleanup } from '../src/cleanup.js';

describe('cleanup._internals.daysAgo', () => {
    it('KST 기준으로 N일 전 YYYY-MM-DD 반환', () => {
        expect(_internals.daysAgo('2026-05-09', 7)).toBe('2026-05-02');
        expect(_internals.daysAgo('2026-05-09', 30)).toBe('2026-04-09');
        expect(_internals.daysAgo('2026-03-01', 1)).toBe('2026-02-28');
    });
});

describe('cleanup._internals._countTeukangStudents', () => {
    it('class_type=특강 + enrollmentCode 매칭 학생만 카운트', () => {
        const students = [
            { docId: 'a', enrollments: [{ class_type: '특강', level_symbol: '', class_number: '수요특강' }] },
            { docId: 'b', enrollments: [{ class_type: '특강', level_symbol: '', class_number: '토요특강' }] },
            { docId: 'c', enrollments: [{ class_type: '정규', level_symbol: 'A', class_number: '101' }] },
        ];
        expect(_internals._countTeukangStudents(students, '수요특강')).toBe(1);
        expect(_internals._countTeukangStudents(students, '없는코드')).toBe(0);
    });
});

describe('cleanup._internals._countNaesinStudents', () => {
    it('정규 enrollment의 csKey 자동 유도가 매칭되면 카운트', () => {
        const students = [{
            docId: 'a',
            name: '김학생',
            branch: '2단지',
            level: '중등',
            school: '신목',
            grade: '2',
            enrollments: [{ class_type: '정규', level_symbol: 'A', class_number: '101' }],
        }];
        // resolveNaesinCsKey: 2단지 + 신목 + 중 + 2 + A = '2단지신목중2A'
        expect(_internals._countNaesinStudents(students, '2단지신목중2A')).toBe(1);
        expect(_internals._countNaesinStudents(students, '2단지없는학교중1A')).toBe(0);
    });

    it('naesin_class_override가 csKey와 일치하면 카운트', () => {
        const students = [{
            docId: 'a',
            branch: '10단지',
            level: '중등',
            school: '양정',
            grade: '3',
            enrollments: [{ class_type: '정규', level_symbol: 'A', class_number: '202', naesin_class_override: '10단지수동매핑' }],
        }];
        expect(_internals._countNaesinStudents(students, '10단지수동매핑')).toBe(1);
        expect(_internals._countNaesinStudents(students, '10단지자동유도결과')).toBe(0);
    });

    it('naesin_class_override === ""(센티넬)이면 자동 유도와 무관하게 미카운트', () => {
        const students = [{
            docId: 'a',
            branch: '2단지',
            level: '중등',
            school: '신목',
            grade: '2',
            enrollments: [{ class_type: '정규', level_symbol: 'A', class_number: '101', naesin_class_override: '' }],
        }];
        expect(_internals._countNaesinStudents(students, '2단지신목중2A')).toBe(0);
    });
});

// runClassCleanup 통합: in-memory db mock
function mockDb({ classSettings, students }) {
    const writes = [];
    const docMock = (path) => ({ path });
    return {
        collection: (name) => ({
            get: async () => {
                if (name === 'class_settings') {
                    return { docs: Object.entries(classSettings).map(([id, data]) => ({ id, data: () => data })) };
                }
                throw new Error(`unexpected collection in get: ${name}`);
            },
            where: () => ({
                get: async () => ({ docs: students.map(s => ({ id: s.docId, data: () => s })) }),
            }),
            doc: () => docMock('history_logs/auto'),
        }),
        doc: (path) => docMock(path),
        batch: () => ({
            delete: (ref) => writes.push({ op: 'delete', ref }),
            set: (ref, data) => writes.push({ op: 'set', ref, data }),
            commit: async () => writes,
        }),
        _writes: writes,
    };
}

describe('runClassCleanup', () => {
    it('grace 통과한 0명 특강만 삭제', async () => {
        const db = mockDb({
            classSettings: {
                '수요특강': { class_type: '특강', special_end: '2026-04-01' }, // 7일 전 cutoff = 2026-05-02 → 통과
                '토요특강': { class_type: '특강', special_end: '2026-05-08' }, // grace 안 지남 → 통과 X
            },
            students: [],
        });
        const result = await runClassCleanup(db, { today: '2026-05-09' });
        expect(result.deleted).toBe(1);
        expect(result.candidates).toEqual([{ code: '수요특강', mode: 'teukang' }]);
    });

    it('학생 1명이라도 있으면 특강 삭제 안 함', async () => {
        const db = mockDb({
            classSettings: { '수요특강': { class_type: '특강', special_end: '2026-04-01' } },
            students: [{ docId: 'a', enrollments: [{ class_type: '특강', class_number: '수요특강' }] }],
        });
        const result = await runClassCleanup(db, { today: '2026-05-09' });
        expect(result.deleted).toBe(0);
    });

    it('grace 통과한 0명 내신만 삭제', async () => {
        const db = mockDb({
            classSettings: {
                '2단지신목중2A': { naesin_start: '2026-02-01', naesin_end: '2026-04-08' }, // 30일 전 cutoff = 2026-04-09 → 통과
                '2단지신목중3B': { naesin_start: '2026-02-01', naesin_end: '2026-05-01' }, // grace 안 지남 → 통과 X
            },
            students: [],
        });
        const result = await runClassCleanup(db, { today: '2026-05-09' });
        expect(result.deleted).toBe(1);
        expect(result.candidates).toEqual([{ code: '2단지신목중2A', mode: 'naesin' }]);
    });

    it('자동 유도로 매칭되는 학생이 있으면 내신 삭제 안 함', async () => {
        const db = mockDb({
            classSettings: { '2단지신목중2A': { naesin_start: '2026-02-01', naesin_end: '2026-04-08' } },
            students: [{
                docId: 'a',
                branch: '2단지',
                level: '중등',
                school: '신목',
                grade: '2',
                enrollments: [{ class_type: '정규', level_symbol: 'A', class_number: '101' }],
            }],
        });
        const result = await runClassCleanup(db, { today: '2026-05-09' });
        expect(result.deleted).toBe(0);
    });

    it('class_settings 비어있으면 no-op', async () => {
        const db = mockDb({ classSettings: {}, students: [] });
        const result = await runClassCleanup(db, { today: '2026-05-09' });
        expect(result.deleted).toBe(0);
        expect(result.candidates).toEqual([]);
    });
});
