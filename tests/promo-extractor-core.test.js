import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRealLevelGrade, pickPrimaryPhone, gridKeyFor, mergeByPhone, branchFromClassNumber, branchFromStudent } from '../promo-extractor-core.js';

test('정상 데이터: 초3 → 초3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 3 }),
        { level: '초등', grade: 3, graduated: false }
    );
});

test('정상 데이터 경계: 초6 → 초6', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 6 }),
        { level: '초등', grade: 6, graduated: false }
    );
});

test('정상 데이터 경계: 중3 → 중3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '중등', grade: 3 }),
        { level: '중등', grade: 3, graduated: false }
    );
});

test('누적 데이터: 초11 → 고2 (사용자 사례)', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 11 }),
        { level: '고등', grade: 2, graduated: false }
    );
});

test('누적 데이터: 초7 → 중1', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: 7 }),
        { level: '중등', grade: 1, graduated: false }
    );
});

test('누적 데이터: 중5 → 고2 (base=6, 6+5=11)', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '중등', grade: 5 }),
        { level: '고등', grade: 2, graduated: false }
    );
});

test('졸업 진입: 고4 → 졸업+1', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '고등', grade: 4 }),
        { level: '졸업', grade: 1, graduated: true }
    );
});

test('졸업 누적: 고6 → 졸업+3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '고등', grade: 6 }),
        { level: '졸업', grade: 3, graduated: true }
    );
});

test('grade 문자열 처리: "3" → 3', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '초등', grade: '3' }),
        { level: '초등', grade: 3, graduated: false }
    );
});

test('grade 없음(0/null): 학부만 반환', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: '중등', grade: null }),
        { level: '중등', grade: 0, graduated: false }
    );
});

test('level 없음: 초등으로 가정', () => {
    assert.deepEqual(
        normalizeRealLevelGrade({ level: null, grade: 5 }),
        { level: '초등', grade: 5, graduated: false }
    );
});

test('학부모₁ 우선', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '010-1', student_phone: '010-2', parent_phone_2: '010-3' }),
        '010-1'
    );
});

test('학부모₁ 없으면 학생본인', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '', student_phone: '010-2', parent_phone_2: '010-3' }),
        '010-2'
    );
});

test('학부모₁·본인 없으면 학부모₂', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: null, student_phone: '', parent_phone_2: '010-3' }),
        '010-3'
    );
});

test('모두 없으면 null', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '', student_phone: null, parent_phone_2: undefined }),
        null
    );
});

test('공백만 있는 번호는 무시', () => {
    assert.equal(
        pickPrimaryPhone({ parent_phone_1: '   ', student_phone: '010-9' }),
        '010-9'
    );
});

test('일반 학생 키: 학부+학년', () => {
    assert.equal(
        gridKeyFor({ level: '초등', grade: 3, graduated: false }),
        '초등3'
    );
    assert.equal(
        gridKeyFor({ level: '고등', grade: 1, graduated: false }),
        '고등1'
    );
});

test('졸업 학생 키: grade 무관 "졸업"', () => {
    assert.equal(
        gridKeyFor({ level: '졸업', grade: 1, graduated: true }),
        '졸업'
    );
    assert.equal(
        gridKeyFor({ level: '졸업', grade: 5, graduated: true }),
        '졸업'
    );
});

test('빈 배열은 빈 배열', () => {
    assert.deepEqual(mergeByPhone([]), []);
});

test('중복 없으면 그대로', () => {
    const rows = [
        { name: '김지유', phone: '010-1', level: '초등', grade: 3 },
        { name: '이서연', phone: '010-2', level: '초등', grade: 4 },
    ];
    const merged = mergeByPhone(rows);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[0].mergedNames, ['김지유']);
});

test('같은 번호 2건 → 1건 병합, 이름 합치기', () => {
    const rows = [
        { name: '김지유', phone: '010-1', level: '초등', grade: 3 },
        { name: '김지윤', phone: '010-1', level: '초등', grade: 5 },
    ];
    const merged = mergeByPhone(rows);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].phone, '010-1');
    assert.deepEqual(merged[0].mergedNames, ['김지유', '김지윤']);
});

test('번호 null인 행은 병합 대상에서 제외(그대로 보존)', () => {
    const rows = [
        { name: '김지유', phone: null, level: '초등', grade: 3 },
        { name: '이서연', phone: null, level: '초등', grade: 4 },
    ];
    const merged = mergeByPhone(rows);
    assert.equal(merged.length, 2);
});

// ─── branchFromClassNumber ────────────────────────────────────────────
test('class_number 1xx → 2단지', () => {
    assert.equal(branchFromClassNumber('103'), '2단지');
    assert.equal(branchFromClassNumber('1'), '2단지');
});

test('class_number 2xx → 10단지', () => {
    assert.equal(branchFromClassNumber('205'), '10단지');
    assert.equal(branchFromClassNumber('2'), '10단지');
});

test('class_number 3xx 이상 또는 빈 값 → 빈 문자열', () => {
    assert.equal(branchFromClassNumber('301'), '');
    assert.equal(branchFromClassNumber(''), '');
    assert.equal(branchFromClassNumber(null), '');
    assert.equal(branchFromClassNumber(undefined), '');
});

// ─── branchFromStudent ────────────────────────────────────────────────
test('branch 필드가 2단지면 그대로 반환', () => {
    assert.equal(branchFromStudent({ branch: '2단지', enrollments: [{ class_number: '205' }] }), '2단지');
});

test('branch 필드가 10단지면 그대로 반환', () => {
    assert.equal(branchFromStudent({ branch: '10단지', enrollments: [{ class_number: '103' }] }), '10단지');
});

test('branch 필드 없고 첫 enrollment 1xx → 2단지', () => {
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '103' }, { class_number: '205' }] }), '2단지');
});

test('branch 필드 없고 첫 enrollment 2xx → 10단지', () => {
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '205' }] }), '10단지');
});

test('branch도 enrollment도 없으면 무소속', () => {
    assert.equal(branchFromStudent({}), '무소속');
    assert.equal(branchFromStudent({ enrollments: [] }), '무소속');
});

test('첫 enrollment의 class_number가 단지로 환산 안 되면 무소속', () => {
    assert.equal(branchFromStudent({ enrollments: [{ class_number: '999' }] }), '무소속');
});

test('branch 필드가 의외값("미지정")이면 enrollment로 폴백', () => {
    assert.equal(branchFromStudent({ branch: '미지정', enrollments: [{ class_number: '103' }] }), '2단지');
    assert.equal(branchFromStudent({ branch: '미지정' }), '무소속');
});
