import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRealLevelGrade, pickPrimaryPhone } from '../promo-extractor-core.js';

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
