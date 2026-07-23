import { randomUUID } from 'node:crypto';
import { accountTypeOf } from '@impact7/shared/enrollment-status';
import { parseClassCode } from './classCode.js';

// 정규 계정 enrollment를 targetCode 기반으로 교체. 특강/기타 계정 보존.
// targetCode 없으면 기존 그대로.
// targetSemester는 leave_request가 박은 학부 현재 학기(클라이언트 결정).
export function replaceRegularEnrollment(student, targetCode, returnDate, classSettings, targetSemester = '') {
  const existing = student?.enrollments || [];
  if (!targetCode) return existing;

  const preserved = existing.filter(e => accountTypeOf(e) !== '정규');
  const cs = classSettings?.[targetCode] || {};
  const days = cs.default_days || (cs.schedule ? Object.keys(cs.schedule) : []);
  const { level_symbol, class_number } = parseClassCode(targetCode);

  const newRegular = {
    account_id: randomUUID(),
    account_type: '정규',
    class_type: '정규',
    level_symbol,
    class_number,
    day: days,
    start_date: returnDate,
  };
  if (targetSemester) newRegular.semester = targetSemester;
  return [...preserved, newRegular];
}
