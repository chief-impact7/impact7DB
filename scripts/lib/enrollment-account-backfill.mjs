import { createHash } from 'node:crypto';
import {
  accountTypeOf,
  groupEnrollmentAccounts,
} from '@impact7/shared/enrollment-status';
import { enrollmentCode } from '@impact7/shared/enrollment-derivation';
import {
  accountClassParts,
  normalizeClassCode,
} from '@impact7/shared/class-code';
import { branchFromClassNumber } from '@impact7/shared/branch';

const REGULAR_CLASS_TYPES = new Set(['', '정규', '내신', '자유학기']);
const PRIMARY_REGULAR_CLASS_TYPES = new Set(['', '정규']);
const INNER_CLASS_TYPES = new Set(['내신', '자유학기']);
const ALLOWED_CLASS_TYPES = new Set(['', '정규', '내신', '자유학기', '특강', '기타']);

export const MANUAL_REASONS = {
  MULTIPLE_REGULAR_CLASS_CODES: '서로 다른 반코드의 정규 항목이 2개 이상',
  INNER_WITHOUT_REGULAR: '내신/자유학기 항목은 있으나 정규 항목 없음',
  UNSUPPORTED_CLASS_TYPE: '허용된 5종 밖의 class_type',
  CONFLICTING_REGULAR_ACCOUNT_IDS: '정규계열 항목에 서로 다른 기존 account_id 존재',
  SHARED_ID_ACROSS_INDEPENDENT_ACCOUNTS: '독립 계정끼리 기존 account_id를 공유',
  EXISTING_ACCOUNT_TYPE_CONFLICT: '기존 account_type이 class_type 기준 유형과 불일치',
};

export const CLASS_SETTING_MANUAL_REASONS = {
  BRANCH_UNRESOLVED: '반코드에서 branch 파생 불가',
};

const hasValue = value => value !== undefined && value !== null && value !== '';
const classType = item => item?.class_type ?? '';
const expectedAccountType = item => accountTypeOf({ class_type: classType(item) });

export function normalizedEnrollmentCode(enrollment) {
  return normalizeClassCode(enrollmentCode(enrollment || {}));
}

export function deterministicAccountId(studentId, accountType, enrollment) {
  const source = [
    studentId,
    accountType,
    normalizedEnrollmentCode(enrollment),
    enrollment?.start_date || '',
    enrollment?.semester || '',
  ].join('|');
  return `acct_${createHash('sha256').update(source).digest('hex').slice(0, 20)}`;
}

export function backfillApprovalFingerprint(projectId, targetStudentCount, changeItemCount) {
  return createHash('sha256')
    .update([projectId, targetStudentCount, changeItemCount].join('|'))
    .digest('hex');
}

export function assertApplyFingerprint(provided, expected) {
  if (provided !== expected) {
    throw new Error('--apply 전 dry-run 결과의 --fingerprint <value>가 필요합니다.');
  }
}

export function enrollmentFingerprint(enrollments) {
  return JSON.stringify(Array.isArray(enrollments) ? enrollments : []);
}

function desiredGroups(enrollments) {
  const regular = [];
  const independent = [];
  for (const [index, item] of enrollments.entries()) {
    if (REGULAR_CLASS_TYPES.has(classType(item))) regular.push({ index, item });
    else independent.push([{ index, item }]);
  }
  return regular.length ? [regular, ...independent] : independent;
}

function manualReasonsFor(enrollments) {
  const reasons = new Set();
  const regularItems = enrollments.filter(item => PRIMARY_REGULAR_CLASS_TYPES.has(classType(item)));
  const regularCodes = new Set(regularItems.map(normalizedEnrollmentCode));

  if (regularCodes.size > 1) reasons.add('MULTIPLE_REGULAR_CLASS_CODES');
  if (enrollments.some(item => INNER_CLASS_TYPES.has(classType(item))) && regularItems.length === 0) {
    reasons.add('INNER_WITHOUT_REGULAR');
  }
  if (enrollments.some(item => !ALLOWED_CLASS_TYPES.has(classType(item)))) {
    reasons.add('UNSUPPORTED_CLASS_TYPE');
  }

  const groups = desiredGroups(enrollments);
  const idOwners = new Map();
  for (const [groupIndex, group] of groups.entries()) {
    const ids = new Set(group.map(({ item }) => item?.account_id).filter(hasValue));
    if (group.length > 1 && ids.size > 1) reasons.add('CONFLICTING_REGULAR_ACCOUNT_IDS');
    for (const id of ids) {
      const owner = idOwners.get(id);
      if (owner !== undefined && owner !== groupIndex) {
        reasons.add('SHARED_ID_ACROSS_INDEPENDENT_ACCOUNTS');
      } else {
        idOwners.set(id, groupIndex);
      }
    }
  }

  if (enrollments.some(item =>
    hasValue(item?.account_type) && item.account_type !== expectedAccountType(item)
  )) {
    reasons.add('EXISTING_ACCOUNT_TYPE_CONFLICT');
  }
  return [...reasons];
}

function summarizeGroups(enrollments) {
  return groupEnrollmentAccounts(enrollments).map(group => ({
    account_id: group.accountId,
    account_type: group.accountType,
    class_codes: group.items.map(normalizedEnrollmentCode),
  }));
}

export function planStudentBackfill(studentId, student) {
  const enrollments = Array.isArray(student?.enrollments) ? student.enrollments : [];
  const missingAccountFields = enrollments.some(item =>
    !hasValue(item?.account_id) || !hasValue(item?.account_type)
  );
  const manualReasons = manualReasonsFor(enrollments);
  const targeted = missingAccountFields || manualReasons.length > 0;
  const fingerprint = enrollmentFingerprint(enrollments);
  if (!targeted) {
    return {
      targeted: false,
      autoBackfillable: false,
      changed: false,
      fingerprint,
      enrollments,
      changes: [],
      manualReasons: [],
    };
  }

  if (manualReasons.length) {
    return {
      targeted: true,
      autoBackfillable: false,
      changed: false,
      fingerprint,
      enrollments,
      changes: [],
      manualReasons,
    };
  }

  const updated = enrollments.map(item => ({ ...item }));
  for (const group of desiredGroups(enrollments)) {
    const seed = group.find(({ item }) => PRIMARY_REGULAR_CLASS_TYPES.has(classType(item)))?.item
      || group[0].item;
    const accountType = expectedAccountType(seed);
    const existingId = group.map(({ item }) => item.account_id).find(hasValue);
    const accountId = existingId || deterministicAccountId(studentId, accountType, seed);

    for (const { index, item } of group) {
      if (!hasValue(item.account_id)) updated[index].account_id = accountId;
      if (!hasValue(item.account_type)) updated[index].account_type = expectedAccountType(item);
    }
  }

  const changes = [];
  updated.forEach((item, index) => {
    const before = enrollments[index];
    const fields = {};
    for (const field of ['account_id', 'account_type']) {
      if (before?.[field] !== item[field]) fields[field] = { before: before?.[field], after: item[field] };
    }
    if (Object.keys(fields).length) changes.push({ index, fields });
  });

  return {
    targeted: true,
    autoBackfillable: true,
    changed: changes.length > 0,
    fingerprint,
    enrollments: updated,
    changes,
    manualReasons: [],
    accountGroups: summarizeGroups(updated),
  };
}

export function planClassSettingBackfill(classCode, settings) {
  const missingAccountType = !hasValue(settings?.account_type);
  const missingBranch = !hasValue(settings?.branch);
  if (!missingAccountType && !missingBranch) {
    return { targeted: false, autoBackfillable: false, changes: {}, manualReasons: [] };
  }

  const accountType = accountTypeOf({ class_type: settings?.class_type || '' });
  const changes = {};
  const manualReasons = [];
  if (missingAccountType) changes.account_type = accountType;
  if (missingBranch) {
    const { classNumber } = accountClassParts(accountType, classCode);
    const branch = branchFromClassNumber(classNumber || classCode);
    if (branch) changes.branch = branch;
    else manualReasons.push('BRANCH_UNRESOLVED');
  }

  return {
    targeted: true,
    autoBackfillable: manualReasons.length === 0,
    changes,
    manualReasons,
  };
}
