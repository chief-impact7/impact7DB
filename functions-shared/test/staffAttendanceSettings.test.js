import { describe, test, expect } from 'vitest';
import { resolveAutoTime, DEFAULT_STAFF_ATTENDANCE_SETTINGS } from '../src/staffAttendanceSettings.js';

describe('DEFAULT_STAFF_ATTENDANCE_SETTINGS', () => {
  test('기본값: dayStartHour=6, autoClockOut.global=null(자동 안 함), autoClockIn.global=null', () => {
    expect(DEFAULT_STAFF_ATTENDANCE_SETTINGS.dayStartHour).toBe(6);
    expect(DEFAULT_STAFF_ATTENDANCE_SETTINGS.autoClockOut.global).toBeNull();
    expect(DEFAULT_STAFF_ATTENDANCE_SETTINGS.autoClockIn.global).toBeNull();
  });
});

describe('resolveAutoTime 우선순위', () => {
  const settings = {
    autoClockOut: {
      global: '22:30',
      byDept: { '교수': '23:00' },
      byStaff: { 'st1': '22:00' },
    },
    autoClockIn: {
      global: null,
      byDept: { '교수': '09:00' },
      byStaff: {},
    },
  };

  test('byStaff가 최우선 — byDept/global 무시', () => {
    expect(resolveAutoTime('out', 'st1', '교수', settings)).toBe('22:00');
  });

  test('byDept가 global보다 우선', () => {
    expect(resolveAutoTime('out', 'st2', '교수', settings)).toBe('23:00');
  });

  test('global 폴백', () => {
    expect(resolveAutoTime('out', 'st3', '행정', settings)).toBe('22:30');
  });

  test('global null이면 null 반환', () => {
    expect(resolveAutoTime('in', 'st3', '행정', settings)).toBeNull();
  });

  test('byDept 있으면 global null 무시', () => {
    expect(resolveAutoTime('in', 'st3', '교수', settings)).toBe('09:00');
  });

  test('byDept/global 모두 null이면 null', () => {
    expect(resolveAutoTime('in', 'st3', '행정', settings)).toBeNull();
  });
});

describe('resolveAutoTime null·빈 문자열 폴백', () => {
  test('settings null → null', () => {
    expect(resolveAutoTime('out', 'st1', '교수', null)).toBeNull();
  });

  test('autoClockOut 블록 없음 → null', () => {
    expect(resolveAutoTime('out', 'st1', null, {})).toBeNull();
  });

  test('byStaff 빈 문자열은 null 취급 → global 폴백', () => {
    const s = { autoClockOut: { global: '22:30', byDept: {}, byStaff: { 'st1': '' } } };
    expect(resolveAutoTime('out', 'st1', null, s)).toBe('22:30');
  });

  test('byDept 빈 문자열은 null 취급 → global 폴백', () => {
    const s = { autoClockOut: { global: '22:30', byDept: { '교수': '' }, byStaff: {} } };
    expect(resolveAutoTime('out', 'st2', '교수', s)).toBe('22:30');
  });

  test('global 빈 문자열 → null', () => {
    const s = { autoClockOut: { global: '', byDept: {}, byStaff: {} } };
    expect(resolveAutoTime('out', 'st1', null, s)).toBeNull();
  });

  test('byStaff null → byDept 폴백', () => {
    const s = { autoClockOut: { global: '22:30', byDept: { '교수': '23:00' }, byStaff: { 'st1': null } } };
    expect(resolveAutoTime('out', 'st1', '교수', s)).toBe('23:00');
  });
});
