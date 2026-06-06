import test from 'node:test';
import assert from 'node:assert/strict';
import {
    enrollmentClassParts,
    selectableClassCodes,
    validateExistingClass,
} from '../class-enrollment-policy.js';

const settings = {
    HA101: { class_type: '정규' },
    I201: {},
    수요특강: { class_type: '특강' },
    내신A: { class_type: '내신' },
};

test('정규와 특강은 class_settings에 존재하는 같은 유형만 선택한다', () => {
    assert.deepEqual(selectableClassCodes(settings, '정규'), ['HA101', 'I201']);
    assert.deepEqual(selectableClassCodes(settings, '특강'), ['수요특강']);
});

test('특강은 전체 반 이름을 class_number로 저장한다', () => {
    assert.deepEqual(
        enrollmentClassParts('특강', '수요특강'),
        { levelSymbol: '', classNumber: '수요특강' },
    );
});

test('정규반 코드를 level_symbol과 class_number로 분리한다', () => {
    assert.deepEqual(
        enrollmentClassParts('정규', 'HA101'),
        { levelSymbol: 'HA', classNumber: '101' },
    );
});

test('존재하지 않거나 유형이 다른 반은 저장을 거부한다', () => {
    assert.match(validateExistingClass(settings, '특강', '특강101'), /반 생성 마법사/);
    assert.match(validateExistingClass(settings, '특강', 'HA101'), /반 생성 마법사/);
    assert.equal(validateExistingClass(settings, '특강', '수요특강'), null);
});
