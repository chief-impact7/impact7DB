import {
  closeAccount,
  deriveStudentStatusAfterAccountChange,
  groupEnrollmentAccounts,
  pauseAccount,
  resumeAccount,
} from '@impact7/shared/enrollment-status';
import { previousDateKST } from './kst.js';

const END_REQUEST_TYPES = new Set(['퇴원요청', '휴원→퇴원', '종강요청']);
const START_REQUEST_TYPES = new Set(['휴원요청', '휴원연장', '복귀요청']);

export function accountApplicationOf(request, today) {
  if (END_REQUEST_TYPES.has(request.request_type)) {
    return {
      marker: 'end_applied_at',
      dueDate: request.withdrawal_date || today,
    };
  }
  if (START_REQUEST_TYPES.has(request.request_type)) {
    let dueDate = today;
    if (request.request_type === '휴원요청') dueDate = request.leave_start_date || today;
    if (request.request_type === '복귀요청') dueDate = request.return_date || today;
    return {
      marker: 'start_applied_at',
      dueDate,
    };
  }
  return null;
}

export function isAccountRequestDue(request, today) {
  if (!request.account_target?.account_id || request.finalized_at) return false;
  const application = accountApplicationOf(request, today);
  return Boolean(
    application
    && !request.account_target[application.marker]
    && application.dueDate <= today
  );
}

function targetAccount(student, accountId) {
  const matches = groupEnrollmentAccounts(student.enrollments)
    .filter(account => account.accountId === accountId || account.key === accountId);
  if (matches.length !== 1) {
    throw new Error(`수강계정 ${accountId} 매칭 실패: ${matches.length}개`);
  }
  return matches[0];
}

function groupAfter(enrollments, accountId) {
  return groupEnrollmentAccounts(enrollments)
    .find(account => account.accountId === accountId || account.key === accountId);
}

function historyEntry(request, student, account, changeType, afterStatus, afterItems, extra = {}) {
  return {
    change_type: changeType,
    account_id: account.accountId,
    account_type: account.accountType,
    source_request_id: request.id || '',
    before: JSON.stringify({
      status: student.status || '',
      account: {
        account_id: account.accountId,
        account_type: account.accountType,
        items: account.items,
      },
    }),
    after: JSON.stringify({
      status: afterStatus,
      account: {
        account_id: account.accountId,
        account_type: account.accountType,
        items: afterItems,
      },
    }),
    ...extra,
  };
}

function applied(marker, deleteStudentFields = []) {
  return {
    [marker]: true,
    finalized_at: true,
    delete_student_fields: deleteStudentFields,
  };
}

function accountEndHistoryEntry(request, student, account, afterStatus, removed, reason, extra = {}) {
  const snapshot = {
    account_id: account.accountId,
    account_type: account.accountType,
    account_key: account.key,
    end_reason: reason,
    student_status_before: student.status || '',
    student_status_after: afterStatus,
    source_request_id: request.id || '',
  };
  return {
    change_type: 'ACCOUNT_END',
    account_id: account.accountId,
    account_type: account.accountType,
    source_request_id: request.id || '',
    before: JSON.stringify({ ...snapshot, items: account.items }),
    after: JSON.stringify({ ...snapshot, items: removed }),
    reason,
    removed,
    ...extra,
  };
}

export function buildAccountFinalize(request, student, today) {
  const accountId = request.account_target?.account_id;
  const account = targetAccount(student, accountId);
  const beforeStatus = student.status || '';
  const application = accountApplicationOf(request, today);
  if (application && application.dueDate > today) {
    return { studentUpdate: null, historyEntries: [], markers: {} };
  }

  if (request.request_type === '휴원요청') {
    const { updatedEnrollments } = pauseAccount(student.enrollments, accountId, {
      pauseStart: request.leave_start_date || today,
      pauseEnd: request.leave_end_date || '',
      leaveSubType: request.leave_sub_type || '실휴원',
    });
    const status = deriveStudentStatusAfterAccountChange(updatedEnrollments, today, {
      currentStatus: beforeStatus,
    });
    return {
      studentUpdate: { enrollments: updatedEnrollments, status },
      historyEntries: [historyEntry(
        request,
        student,
        account,
        'ACCOUNT_PAUSE',
        status,
        groupAfter(updatedEnrollments, accountId)?.items || [],
        { reason: '휴원요청' },
      )],
      markers: applied('start_applied_at'),
    };
  }

  if (request.request_type === '휴원연장') {
    const targetItems = new Set(account.items);
    const updatedEnrollments = (student.enrollments || []).map(item => (
      targetItems.has(item)
        ? { ...item, pause_end_date: request.leave_end_date || '' }
        : item
    ));
    return {
      studentUpdate: { enrollments: updatedEnrollments },
      historyEntries: [historyEntry(
        request,
        student,
        account,
        'ACCOUNT_PAUSE',
        beforeStatus,
        groupAfter(updatedEnrollments, accountId)?.items || [],
        { reason: '휴원연장' },
      )],
      markers: applied('start_applied_at'),
    };
  }

  if (request.request_type === '복귀요청') {
    const { updatedEnrollments } = resumeAccount(student.enrollments, accountId);
    const status = deriveStudentStatusAfterAccountChange(updatedEnrollments, today);
    return {
      studentUpdate: { enrollments: updatedEnrollments, status },
      historyEntries: [historyEntry(
        request,
        student,
        account,
        'ACCOUNT_RESUME',
        status,
        groupAfter(updatedEnrollments, accountId)?.items || [],
        { reason: '복귀요청' },
      )],
      markers: applied('start_applied_at'),
    };
  }

  if (END_REQUEST_TYPES.has(request.request_type)) {
    const reason = request.request_type === '종강요청' ? '종강' : '퇴원';
    const endDate = previousDateKST(request.withdrawal_date || today);

    const { updatedEnrollments, removed } = closeAccount(student.enrollments, accountId, {
      endDate,
      endReason: reason,
    });
    const status = deriveStudentStatusAfterAccountChange(updatedEnrollments, today, {
      fallbackReason: reason,
      currentStatus: beforeStatus,
    });
    const deleteStudentFields = ['퇴원', '종강'].includes(status)
      ? [
          'pause_start_date',
          'pause_end_date',
          'withdrawal_date',
          'pre_withdrawal_status',
          'scheduled_leave_status',
        ]
      : [];
    const startDates = removed.map(item => item.start_date).filter(Boolean).sort();
    return {
      studentUpdate: { enrollments: updatedEnrollments, status },
      historyEntries: [accountEndHistoryEntry(
        request,
        student,
        account,
        status,
        removed,
        reason,
        {
          period: {
            start_date: startDates[0] || '',
            end_date: endDate,
          },
        },
      )],
      markers: applied('end_applied_at', deleteStudentFields),
    };
  }

  throw new Error(`계정 범위에서 지원하지 않는 request_type: ${request.request_type}`);
}
