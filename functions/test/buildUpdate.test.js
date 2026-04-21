import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildUpdate } from '../src/buildUpdate.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-21T03:00:00Z')); // KST 12:00
});

const baseStu = { id: 'a', name: '김철수', status: '재원', enrollments: [] };

describe('buildUpdate — 휴원요청', () => {
  it('시작일이 오늘 → status 변경 즉시', () => {
    const r = {
      request_type: '휴원요청',
      leave_sub_type: '실휴원',
      leave_start_date: '2026-04-21',
      leave_end_date: '2026-05-31',
    };
    const { studentUpdate, changeType } = buildUpdate(r, baseStu, {}, []);
    expect(changeType).toBe('UPDATE');
    expect(studentUpdate.status).toBe('실휴원');
    expect(studentUpdate.pause_start_date).toBe('2026-04-21');
    expect(studentUpdate.pause_end_date).toBe('2026-05-31');
    expect(studentUpdate.scheduled_leave_status).toBeUndefined();
  });

  it('시작일이 미래 → scheduled_leave_status 예약, status 유지', () => {
    const r = {
      request_type: '휴원요청',
      leave_sub_type: '가휴원',
      leave_start_date: '2026-05-01',
      leave_end_date: '2026-06-01',
    };
    const { studentUpdate } = buildUpdate(r, baseStu, {}, []);
    expect(studentUpdate.status).toBeUndefined();
    expect(studentUpdate.scheduled_leave_status).toBe('가휴원');
    expect(studentUpdate.pause_start_date).toBe('2026-05-01');
  });
});

describe('buildUpdate — 휴원연장', () => {
  it('pause_end_date만 갱신', () => {
    const r = { request_type: '휴원연장', leave_end_date: '2026-07-31' };
    const stu = { ...baseStu, status: '실휴원', pause_start_date: '2026-04-01', pause_end_date: '2026-05-31' };
    const { studentUpdate } = buildUpdate(r, stu, {}, []);
    expect(studentUpdate.pause_end_date).toBe('2026-07-31');
    expect(studentUpdate.status).toBeUndefined();
    expect(studentUpdate.pause_start_date).toBeUndefined();
  });
});
