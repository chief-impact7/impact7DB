import test from 'node:test';
import assert from 'node:assert/strict';
import {
    enrollmentClassParts,
    selectableClassCodes,
    validateExistingClass,
} from '../class-enrollment-policy.js';
import {
    accountLabel,
    accountTarget,
    accountTargetExists,
    activeStudentEnrollments,
    assignEnrollmentAccounts,
    closeExpiredSpecialAccounts,
    closeStudentAccount,
    closeStudentAccounts,
    mergeImportedEnrollments,
    studentAccounts,
} from '../enrollment-accounts.js';
import { classifyHistory } from '@impact7/shared/history';

const settings = {
    HA101: { class_type: '정규' },
    I201: {},
    수요특강: { class_type: '특강' },
    기타반: { class_type: '기타' },
    명시기타: { account_type: '기타', class_type: '정규' },
    내신A: { class_type: '내신' },
};

test('정규·특강·기타는 class_settings에 존재하는 같은 계정 유형만 선택한다', () => {
    assert.deepEqual(selectableClassCodes(settings, '정규'), ['HA101', 'I201']);
    assert.deepEqual(selectableClassCodes(settings, '특강'), ['수요특강']);
    assert.deepEqual(selectableClassCodes(settings, '기타'), ['기타반', '명시기타']);
});

test('특강과 기타는 전체 반 이름을 class_number로 저장한다', () => {
    assert.deepEqual(
        enrollmentClassParts('특강', '수요특강'),
        { levelSymbol: '', classNumber: '수요특강' },
    );
    assert.deepEqual(
        enrollmentClassParts('기타', '기타반'),
        { levelSymbol: '', classNumber: '기타반' },
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
    assert.equal(validateExistingClass(settings, '기타', '기타반'), null);
});

test('학생 계정 뷰는 계정별로 묶고 종료 계정을 제외한다', () => {
    const regular = { account_id: 'regular', class_type: '정규', level_symbol: 'HA', class_number: '101' };
    const naesin = { account_id: 'regular', account_type: '정규', class_type: '내신', class_number: '내신A' };
    const other = { account_id: 'other', account_type: '기타', class_type: '기타', class_number: '기타반' };
    const ended = { account_id: 'ended', class_type: '특강', class_number: '종료특강', end_date: '2026-07-22' };

    const accounts = studentAccounts({ enrollments: [regular, naesin, other, ended] }, '2026-07-23');

    assert.deepEqual(accounts.map(account => account.label), ['정규 HA101', '기타 기타반']);
    assert.deepEqual(accounts.map(account => account.state), ['활성', '활성']);
    assert.deepEqual(accounts[0].items, [regular, naesin]);
    assert.equal(accountLabel({ accountType: '특강', items: [{ class_number: 'GR901' }] }), '특강 GR901');
});

test('활성 enrollment 판정은 shared 날짜 필터에 위임한다', () => {
    const old = { class_type: '정규', level_symbol: 'HA', class_number: '101', start_date: '2025-01-01' };
    const current = { class_type: '정규', level_symbol: 'HA', class_number: '101', start_date: '2026-01-01' };
    const ended = { class_type: '특강', class_number: '종료특강', end_date: '2026-07-22' };
    const endedNaesin = { class_type: '내신', class_number: '내신A', end_date: '2026-07-22' };
    const other = { class_type: '기타', class_number: '기타반' };

    assert.deepEqual(
        activeStudentEnrollments({ enrollments: [old, current, ended, endedNaesin, other] }, '2026-07-23'),
        [old, current, other],
    );
});

test('계정 휴원·재개·종료 이력은 수업이력 분류를 통과한다', () => {
    assert.deepEqual(
        ['ACCOUNT_PAUSE', 'ACCOUNT_RESUME', 'ACCOUNT_END'].map(change_type => classifyHistory({ change_type })?.label),
        ['계정휴원', '계정재개', '계정종료'],
    );
});

test('신규 수업은 계정을 발급하고 내신·자유학기는 대상 정규 계정을 공유한다', () => {
    let sequence = 0;
    const createId = () => `account-${++sequence}`;
    const result = assignEnrollmentAccounts([
        { class_type: '정규', level_symbol: 'HA', class_number: '101', naesin_class_override: '내신A' },
        { class_type: '자유학기', level_symbol: 'HA', class_number: '101' },
        { class_type: '내신', class_number: '내신A' },
        { class_type: '특강', class_number: 'GR901' },
        { class_type: '기타', class_number: '기타반' },
    ], { createId });

    assert.equal(result.valid, true);
    assert.deepEqual(
        result.enrollments.map(item => [item.account_id, item.account_type]),
        [
            ['account-1', '정규'],
            ['account-1', '정규'],
            ['account-1', '정규'],
            ['account-2', '특강'],
            ['account-3', '기타'],
        ],
    );
});

test('계정 종강은 잔존 계정이 있으면 status를 유지하고 마지막 계정이면 종강한다', () => {
    const regular = { account_id: 'regular', account_type: '정규', class_type: '정규', class_number: '101' };
    const special = { account_id: 'special', account_type: '특강', class_type: '특강', class_number: 'GR901' };
    const student = {
        status: '재원',
        pause_start_date: '2026-07-01',
        enrollments: [regular, special],
    };

    const first = closeStudentAccount(student, special, {
        dateStr: '2026-07-23',
        endReason: '종강',
    });
    assert.equal(first.status, '재원');
    assert.deepEqual(first.updatedEnrollments, [regular]);
    assert.deepEqual(first.removed, [{ ...special, end_date: '2026-07-23', end_reason: '종강' }]);
    assert.deepEqual(first.cleanupFields, []);

    const last = closeStudentAccount({ ...student, enrollments: [regular] }, regular, {
        dateStr: '2026-07-23',
        endReason: '종강',
    });
    assert.equal(last.status, '종강');
    assert.deepEqual(last.updatedEnrollments, []);
    assert.ok(last.cleanupFields.includes('pause_start_date'));
    const beforeSnapshot = JSON.parse(last.history.before);
    const afterSnapshot = JSON.parse(last.history.after);
    assert.deepEqual(Object.keys(beforeSnapshot).sort(), [
        'account_id',
        'account_key',
        'account_type',
        'end_reason',
        'items',
        'student_status_after',
        'student_status_before',
    ]);
    assert.deepEqual(Object.keys(afterSnapshot).sort(), Object.keys(beforeSnapshot).sort());
    assert.equal(afterSnapshot.items[0].end_reason, '종강');
});

test('레거시 정규 그룹도 account_id 없이 한 계정으로 종료한다', () => {
    const regular = { class_type: '정규', level_symbol: 'HA', class_number: '101' };
    const naesin = { class_type: '내신', class_number: '내신A' };
    const special = { class_type: '특강', class_number: 'GR901' };
    const result = closeStudentAccount(
        { status: '재원', enrollments: [regular, naesin, special] },
        regular,
        { dateStr: '2026-07-23', endReason: '퇴원' },
    );

    assert.deepEqual(result.updatedEnrollments, [special]);
    assert.deepEqual(result.removed.map(item => item.class_type), ['정규', '내신']);
    assert.equal(result.status, '재원');

    const [account] = studentAccounts({ enrollments: [regular, naesin, special] }, '2026-07-23');
    const target = accountTarget(account, '2단지');
    assert.equal(target.account_id, 'legacy:정규:HA101');
    assert.equal(accountTargetExists({ enrollments: [regular, naesin, special] }, target), true);
});

test('만료 특강은 원래 종료일로 계정 종료 이력을 만든다', () => {
    const result = closeExpiredSpecialAccounts({
        status: '재원',
        enrollments: [{
            account_id: 'special',
            account_type: '특강',
            class_type: '특강',
            class_number: 'GR901',
            end_date: '2026-07-22',
        }],
    }, '2026-07-23');

    assert.equal(result.changed, true);
    assert.equal(result.status, '종강');
    assert.deepEqual(result.enrollments, []);
    assert.equal(JSON.parse(result.histories[0].after).items[0].end_date, '2026-07-22');
});

test('부분 종료는 현재 재원계열 status를 보존한다', () => {
    const regular = { account_id: 'regular', account_type: '정규', class_type: '정규', class_number: '101' };
    const special = { account_id: 'special', account_type: '특강', class_type: '특강', class_number: 'GR901' };
    const result = closeStudentAccount(
        { status: '실휴원', enrollments: [regular, special] },
        'special',
        { dateStr: '2026-07-23', endReason: '종강' },
    );

    assert.equal(result.status, '실휴원');
});

test('같은 반코드의 복수 계정은 shared key로 정확히 선택한다', () => {
    const first = { account_id: 'first', account_type: '특강', class_type: '특강', class_number: 'GR901' };
    const second = { account_id: 'second', account_type: '특강', class_type: '특강', class_number: 'GR901' };
    const student = { status: '재원', enrollments: [first, second] };

    const single = closeStudentAccount(student, 'second', {
        dateStr: '2026-07-23',
        endReason: '종강',
    });
    assert.deepEqual(single.updatedEnrollments, [first]);

    const all = closeStudentAccounts(student, ['first', 'second'], {
        dateStr: '2026-07-23',
        endReason: '종강',
    });
    assert.deepEqual(all.updatedEnrollments, []);
    assert.equal(all.histories.length, 2);
});

test('특강 계정은 모든 항목이 만료된 뒤에만 종료한다', () => {
    const result = closeExpiredSpecialAccounts({
        status: '재원',
        enrollments: [
            {
                account_id: 'special',
                account_type: '특강',
                class_type: '특강',
                class_number: 'GR901',
                end_date: '2026-07-22',
            },
            {
                account_id: 'special',
                account_type: '특강',
                class_type: '특강',
                class_number: 'GR901-보강',
                end_date: '2026-07-30',
            },
        ],
    }, '2026-07-23');

    assert.equal(result.changed, false);
    assert.equal(result.enrollments.length, 2);
});

test('CSV 병합은 account_id를 우선하고 레거시는 반코드+학기로 병합한다', () => {
    const existing = [{
        account_id: 'regular-a',
        account_type: '정규',
        class_type: '정규',
        level_symbol: 'HA',
        class_number: '101',
        semester: '2026-Summer',
        day: ['월'],
    }];

    const byAccount = mergeImportedEnrollments(existing, [{
        account_id: 'regular-a',
        account_type: '정규',
        class_type: '정규',
        level_symbol: 'HA',
        class_number: '101',
        semester: '2026-Summer',
        day: ['화'],
    }]);
    assert.equal(byAccount.enrollments.length, 1);
    assert.deepEqual(byAccount.enrollments[0].day, ['화']);

    const withNaesin = mergeImportedEnrollments(existing, [
        existing[0],
        {
            account_id: 'regular-a',
            account_type: '정규',
            class_type: '내신',
            class_number: '내신A',
            semester: '2026-Summer',
            day: ['금'],
        },
    ]);
    assert.deepEqual(withNaesin.enrollments.map(item => item.class_type), ['정규', '내신']);

    const legacy = mergeImportedEnrollments(existing, [{
        class_type: '정규',
        level_symbol: 'HA',
        class_number: '101',
        semester: '2026-Summer',
        day: ['수'],
    }]);
    assert.equal(legacy.enrollments.length, 1);
    assert.equal(legacy.enrollments[0].account_id, 'regular-a');
    assert.deepEqual(legacy.enrollments[0].day, ['수']);

    const inactive = mergeImportedEnrollments(existing, [{
        class_type: '정규',
        level_symbol: 'HA',
        class_number: '101',
    }], { status: '퇴원' });
    assert.deepEqual(inactive.enrollments, []);
    assert.equal(inactive.cleared, true);
});
