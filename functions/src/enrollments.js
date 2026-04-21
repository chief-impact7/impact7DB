import { parseClassCode } from './classCode.js';

const REGULAR_KEYS = ['정규', undefined, null];

// 정규 enrollment를 targetCode 기반으로 교체. 내신/특강/자유학기 보존.
// targetCode 없으면 기존 그대로.
export function replaceRegularEnrollment(student, targetCode, returnDate, classSettings) {
  const existing = student?.enrollments || [];
  if (!targetCode) return existing;

  const preserved = existing.filter(e => !REGULAR_KEYS.includes(e?.class_type));
  const cs = classSettings?.[targetCode] || {};
  const days = cs.default_days
    || (cs.schedule ? Object.keys(cs.schedule) : [])
    || [];
  const { level_symbol, class_number } = parseClassCode(targetCode);

  const newRegular = {
    class_type: '정규',
    level_symbol,
    class_number,
    day: days,
    start_date: returnDate,
  };
  return [...preserved, newRegular];
}
