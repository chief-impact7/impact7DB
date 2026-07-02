export const DEFAULT_STAFF_ATTENDANCE_SETTINGS = {
  dayStartHour: 6,
  autoClockOut: { global: '22:30', byDept: {}, byStaff: {} },
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
