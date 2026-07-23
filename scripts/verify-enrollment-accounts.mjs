import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  ACCOUNT_TYPES,
  ENROLLABLE_STATUSES,
  NON_ENROLLABLE_STATUSES,
  groupEnrollmentAccounts,
  openAccounts,
} from '@impact7/shared/enrollment-status';
import { todayKST } from '@impact7/shared/datetime';
import { normalizedEnrollmentCode } from './lib/enrollment-account-backfill.mjs';

initializeApp({ credential: applicationDefault(), projectId: 'impact7db' });
const db = getFirestore();
const dateStr = todayKST();

function logicalAccountKeys(studentId, groupedAccounts) {
  return groupedAccounts
    .filter(group => group.accountId)
    .map(group => ({
      accountId: group.accountId,
      key: `${studentId}|${group.key}`,
      studentId,
      accountType: group.accountType,
      classCode: normalizedEnrollmentCode(group.items[0]),
    }));
}

async function run() {
  const snapshot = await db.collection('students').get();
  const report = {
    verified_at: new Date().toISOString(),
    date: dateStr,
    students_scanned: snapshot.size,
    enrollable_without_open_account: [],
    non_enrollable_with_enrollments: [],
    duplicate_account_id_groups: [],
    invalid_account_types: [],
    missing_account_id_entries: [],
    inner_regular_account_mismatches: [],
  };
  const ids = new Map();

  for (const doc of snapshot.docs) {
    const student = doc.data();
    const enrollments = Array.isArray(student.enrollments) ? student.enrollments : [];
    const identity = { id: doc.id, name: student.name || '', status: student.status || '' };

    if (ENROLLABLE_STATUSES.has(student.status) && openAccounts(enrollments, dateStr).length === 0) {
      report.enrollable_without_open_account.push(identity);
    }
    if (NON_ENROLLABLE_STATUSES.has(student.status) && enrollments.length > 0) {
      report.non_enrollable_with_enrollments.push({ ...identity, enrollment_count: enrollments.length });
    }

    enrollments.forEach((item, index) => {
      if (item?.account_type != null && !item.account_id) {
        report.missing_account_id_entries.push({
          ...identity,
          enrollment_index: index,
          account_type: item.account_type,
          class_code: normalizedEnrollmentCode(item),
        });
      }
      if (!ACCOUNT_TYPES.includes(item?.account_type)) {
        report.invalid_account_types.push({
          ...identity,
          enrollment_index: index,
          account_id: item?.account_id || null,
          account_type: item?.account_type ?? null,
        });
      }
    });

    const groupedAccounts = groupEnrollmentAccounts(enrollments);
    for (const entry of logicalAccountKeys(doc.id, groupedAccounts)) {
      if (!ids.has(entry.accountId)) ids.set(entry.accountId, new Map());
      ids.get(entry.accountId).set(entry.key, entry);
    }

    const regularIds = new Set(groupedAccounts
      .filter(group =>
        group.accountType === '정규'
        && group.items.some(item => ['', '정규'].includes(item?.class_type ?? ''))
      )
      .map(group => group.accountId)
      .filter(Boolean));
    const mismatched = enrollments
      .map((item, index) => ({ item, index }))
      .filter(({ item }) =>
        ['내신', '자유학기'].includes(item?.class_type)
        && !regularIds.has(item.account_id)
      );
    if (mismatched.length) {
      report.inner_regular_account_mismatches.push({
        ...identity,
        regular_account_ids: [...regularIds],
        inner_items: mismatched.map(({ item, index }) => ({
          enrollment_index: index,
          class_type: item.class_type,
          account_id: item.account_id || null,
        })),
      });
    }
  }

  for (const [accountId, logicalGroups] of ids) {
    if (logicalGroups.size > 1) {
      report.duplicate_account_id_groups.push({
        account_id: accountId,
        groups: [...logicalGroups.values()],
      });
    }
  }

  report.counts = {
    enrollable_without_open_account: report.enrollable_without_open_account.length,
    non_enrollable_with_enrollments: report.non_enrollable_with_enrollments.length,
    duplicate_account_id_groups: report.duplicate_account_id_groups.length,
    invalid_account_types: report.invalid_account_types.length,
    missing_account_id_entries: report.missing_account_id_entries.length,
    inner_regular_account_mismatches: report.inner_regular_account_mismatches.length,
  };
  const totalProblems = Object.values(report.counts).reduce((sum, count) => sum + count, 0);
  report.counts.total = totalProblems;
  if (totalProblems > 0) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
