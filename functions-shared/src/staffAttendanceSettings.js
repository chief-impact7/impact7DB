// 자동 출/퇴근 기본은 null(=자동 안 함) — 관리자가 설정에서 시각을 입력해야만 작동한다.
// (사용자 요구: 입력 없으면 자동 반영하지 않음)
export const DEFAULT_STAFF_ATTENDANCE_SETTINGS = {
  dayStartHour: 6,
  autoClockOut: { global: null, byDept: {}, byStaff: {} },
  autoClockIn: { global: null, byDept: {}, byStaff: {} },
};

function pick(v) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return undefined;
  return v;
}

export function resolveAutoTime(kind, staffId, dept, settings) {
  if (!settings) return null;
  const block = kind === 'out' ? settings.autoClockOut : settings.autoClockIn;
  if (!block) return null;
  return pick((block.byStaff ?? {})[staffId]) ?? pick((block.byDept ?? {})[dept]) ?? pick(block.global) ?? null;
}
