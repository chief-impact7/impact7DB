import { todayKST } from './kst.js';
import { replaceRegularEnrollment } from './enrollments.js';
import { deduplicateName } from './dedupName.js';

const RETURN_TYPES = new Set(['복귀요청', '재등원요청']);
const WITHDRAW_TYPES = new Set(['퇴원요청', '휴원→퇴원']);

export function buildUpdate(r, student, classSettings, allStudents) {
  const today = todayKST();

  if (r.request_type === '휴원연장') {
    return {
      studentUpdate: { pause_end_date: r.leave_end_date || '' },
      changeType: 'UPDATE',
    };
  }

  if (RETURN_TYPES.has(r.request_type)) {
    // Task 1.8에서 채움
    throw new Error('not implemented');
  }
  if (WITHDRAW_TYPES.has(r.request_type)) {
    // Task 1.7에서 채움
    throw new Error('not implemented');
  }

  // 휴원요청 / 퇴원→휴원
  const subType = r.leave_sub_type || '실휴원';
  const start = r.leave_start_date || '';
  const studentUpdate = {
    pause_start_date: start,
    pause_end_date: r.leave_end_date || '',
  };
  if (start && start > today) {
    studentUpdate.scheduled_leave_status = subType;
  } else {
    studentUpdate.status = subType;
  }
  return { studentUpdate, changeType: 'UPDATE' };
}
