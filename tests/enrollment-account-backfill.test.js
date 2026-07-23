import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertApplyFingerprint,
  backfillApprovalFingerprint,
  deterministicAccountId,
  planClassSettingBackfill,
  planStudentBackfill,
} from '../scripts/lib/enrollment-account-backfill.mjs';

test('apply fingerprint가 다르면 차단하고 일치하면 허용한다', () => {
  const fingerprint = backfillApprovalFingerprint('impact7db', 12, 18);
  assert.throws(
    () => assertApplyFingerprint('mismatch', fingerprint),
    /--apply 전 dry-run 결과/,
  );
  assert.doesNotThrow(() => assertApplyFingerprint(fingerprint, fingerprint));
});

test('결정적 ID는 정규화 반코드와 지정된 5개 입력으로 생성된다', () => {
  const enrollment = {
    level_symbol: 'ha',
    class_number: '101',
    start_date: '2026-03-02',
    semester: '2026-1',
  };
  assert.equal(
    deterministicAccountId('student-1', '정규', enrollment),
    'acct_3a3c559370464debc62d',
  );
  assert.equal(
    deterministicAccountId('student-1', '정규', { ...enrollment, level_symbol: ' HA' }),
    'acct_3a3c559370464debc62d',
  );
});

test('정규·내신·자유학기는 한 계정으로 묶고 특강·기타는 각각 독립 계정이다', () => {
  const result = planStudentBackfill('student-1', {
    enrollments: [
      { class_type: '정규', level_symbol: 'HA', class_number: '101', start_date: '2026-03-02' },
      { class_type: '내신', class_number: '2단지목동중1' },
      { class_type: '자유학기', level_symbol: 'HA', class_number: '101' },
      { class_type: '특강', class_number: '수요특강' },
      { class_type: '기타', class_number: '보강' },
    ],
  });

  assert.equal(result.autoBackfillable, true);
  assert.deepEqual(result.enrollments.map(item => item.account_type), ['정규', '정규', '정규', '특강', '기타']);
  assert.equal(result.enrollments[0].account_id, result.enrollments[1].account_id);
  assert.equal(result.enrollments[0].account_id, result.enrollments[2].account_id);
  assert.notEqual(result.enrollments[0].account_id, result.enrollments[3].account_id);
  assert.notEqual(result.enrollments[3].account_id, result.enrollments[4].account_id);
});

test('기존 정규 account_id는 바꾸지 않고 누락된 같은 그룹 항목에 전파한다', () => {
  const result = planStudentBackfill('student-1', {
    enrollments: [
      { account_id: 'legacy-fixed', class_type: '정규', level_symbol: 'HA', class_number: '101' },
      { class_type: '내신', class_number: '2단지목동중1' },
    ],
  });

  assert.equal(result.enrollments[0].account_id, 'legacy-fixed');
  assert.equal(result.enrollments[1].account_id, 'legacy-fixed');
  assert.equal(result.enrollments[0].account_type, '정규');
});

test('서로 다른 정규 반코드는 수동 목록으로 분류한다', () => {
  const result = planStudentBackfill('student-1', {
    enrollments: [
      { class_type: '정규', level_symbol: 'HA', class_number: '101' },
      { class_type: '정규', level_symbol: 'HB', class_number: '102' },
    ],
  });
  assert.deepEqual(result.manualReasons, ['MULTIPLE_REGULAR_CLASS_CODES']);
});

test('내신/자유학기만 있거나 class_type이 허용 범위 밖이면 수동 분류한다', () => {
  assert.deepEqual(
    planStudentBackfill('student-1', {
      enrollments: [{ class_type: '내신', class_number: '2단지목동중1' }],
    }).manualReasons,
    ['INNER_WITHOUT_REGULAR'],
  );
  assert.deepEqual(
    planStudentBackfill('student-2', {
      enrollments: [{ class_type: '단과', class_number: '101' }],
    }).manualReasons,
    ['UNSUPPORTED_CLASS_TYPE'],
  );
});

test('대소문자만 다른 정규 반코드는 같은 코드로 판정한다', () => {
  const result = planStudentBackfill('student-1', {
    enrollments: [
      { class_type: '정규', level_symbol: 'ha', class_number: '101' },
      { class_type: '정규', level_symbol: 'HA', class_number: '101' },
    ],
  });
  assert.equal(result.autoBackfillable, true);
  assert.equal(result.enrollments[0].account_id, result.enrollments[1].account_id);
});

test('기존 계정 필드가 모두 있어도 충돌은 수동 분류한다', () => {
  assert.deepEqual(
    planStudentBackfill('student-1', {
      enrollments: [
        { account_id: 'regular-a', account_type: '정규', class_type: '정규', class_number: '101' },
        { account_id: 'regular-b', account_type: '정규', class_type: '정규', class_number: '101' },
      ],
    }).manualReasons,
    ['CONFLICTING_REGULAR_ACCOUNT_IDS'],
  );
  assert.deepEqual(
    planStudentBackfill('student-2', {
      enrollments: [
        { account_id: 'shared', account_type: '정규', class_type: '정규', class_number: '101' },
        { account_id: 'shared', account_type: '특강', class_type: '특강', class_number: '특강A' },
      ],
    }).manualReasons,
    ['SHARED_ID_ACROSS_INDEPENDENT_ACCOUNTS'],
  );
  assert.deepEqual(
    planStudentBackfill('student-3', {
      enrollments: [
        { account_id: 'wrong-type', account_type: '특강', class_type: '정규', class_number: '101' },
      ],
    }).manualReasons,
    ['EXISTING_ACCOUNT_TYPE_CONFLICT'],
  );
});

test('class_settings는 누락 필드만 유형·지점 규칙으로 채운다', () => {
  assert.deepEqual(
    planClassSettingBackfill('HA101', { class_type: '' }),
    {
      targeted: true,
      autoBackfillable: true,
      changes: { account_type: '정규', branch: '2단지' },
      manualReasons: [],
    },
  );
  assert.deepEqual(
    planClassSettingBackfill('수요특강', { class_type: '특강' }),
    {
      targeted: true,
      autoBackfillable: false,
      changes: { account_type: '특강' },
      manualReasons: ['BRANCH_UNRESOLVED'],
    },
  );
});
