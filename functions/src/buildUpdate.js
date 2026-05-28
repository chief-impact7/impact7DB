import { todayKST } from './kst.js';
import { replaceRegularEnrollment } from './enrollments.js';
import { deduplicateName } from './dedupName.js';

const RETURN_TYPES = new Set(['복귀요청', '재등원요청']);
const WITHDRAW_TYPES = new Set(['퇴원요청', '휴원→퇴원']);
const LEAVE_TYPES = new Set(['휴원요청', '퇴원→휴원']);

export function buildUpdate(r, student, classSettings, allStudents) {
  const today = todayKST();

  if (r.request_type === '휴원연장') {
    return {
      studentUpdate: { pause_end_date: r.leave_end_date || '' },
      changeType: 'UPDATE',
    };
  }

  if (RETURN_TYPES.has(r.request_type)) {
    // 복귀/재등원 진입은 '등원예정' 경유로 통일 — enrollment.start_date(=복귀일)에
    // 도달하면 클라이언트 promoteEnrollPending이 자동 '재원' 전환. 복귀일이 오늘 이전이면
    // 첫 promote 사이클에서 즉시 재원. (휴먼에러·수동 재원선택 제거)
    // 정책: buildUpdate는 set만, 부속 필드 deleteField는 finalize.js가 담당.
    const studentUpdate = { status: '등원예정' };
    const dedup = deduplicateName(student.id, student.name || '', allStudents);
    if (dedup) studentUpdate.name = dedup;
    const enrollments = replaceRegularEnrollment(
      student,
      r.target_class_code || '',
      r.return_date || today,
      classSettings,
      r.target_semester || '',
    );
    return { studentUpdate, enrollments, changeType: 'RETURN' };
  }
  if (WITHDRAW_TYPES.has(r.request_type)) {
    const wDate = r.withdrawal_date || today;
    // 정책: buildUpdate는 set만, pause_*/scheduled_leave_status deleteField는 finalize.js가 담당.
    const studentUpdate = { withdrawal_date: wDate };
    if (wDate > today) {
      // status 없는 레거시 문서는 재원으로 간주
      studentUpdate.pre_withdrawal_status = student.status || '재원';
    } else {
      studentUpdate.status = '퇴원';
    }
    return { studentUpdate, changeType: 'WITHDRAW' };
  }

  if (!LEAVE_TYPES.has(r.request_type)) {
    throw new Error(`알 수 없는 request_type: ${r.request_type}`);
  }

  // 휴원요청 / 퇴원→휴원
  // 정책: buildUpdate는 set만, withdrawal_date/pre_withdrawal_status/scheduled_leave_status
  // 등 deleteField는 finalize.js의 UPDATE 분기가 담당.
  const subType = r.leave_sub_type || '실휴원';
  // leave_start_date가 없으면 오늘 시작으로 간주 → 즉시 상태 변경
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
