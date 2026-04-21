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

describe('buildUpdate — 재등원/복귀요청', () => {
  const cs = { A103: { default_days: ['월', '수'] } };

  it('재등원: status=재원, enrollment 정규 교체', () => {
    const stu = {
      id: 'a',
      name: '유시우',
      status: '퇴원',
      enrollments: [
        { class_type: '내신', class_number: '103', day: ['화'], end_date: '2026-05-03' },
      ],
    };
    const r = { request_type: '재등원요청', target_class_code: 'A103', return_date: '2026-04-21' };
    const { studentUpdate, changeType, enrollments } = buildUpdate(r, stu, cs, []);
    expect(changeType).toBe('RETURN');
    expect(studentUpdate.status).toBe('재원');
    expect(enrollments).toHaveLength(2);
    expect(enrollments.find(e => e.class_type === '정규').class_number).toBe('103');
    expect(enrollments.find(e => e.class_type === '내신')).toBeDefined();
  });

  it('복귀: status=재원, target 없으면 기존 enrollment 유지', () => {
    const stu = {
      id: 'a',
      name: '김민수',
      status: '실휴원',
      enrollments: [{ class_type: '정규', class_number: '101', day: ['월', '금'] }],
      pause_start_date: '2026-03-01',
      pause_end_date: '2026-04-30',
    };
    const r = { request_type: '복귀요청', return_date: '2026-04-21' };
    const { studentUpdate, enrollments } = buildUpdate(r, stu, cs, []);
    expect(studentUpdate.status).toBe('재원');
    expect(enrollments).toEqual(stu.enrollments);
  });

  it('동명이인 → 숫자 접미사', () => {
    const stu = { id: 'a', name: '김철수', status: '퇴원', enrollments: [] };
    const allStudents = [{ id: 'b', name: '김철수', status: '재원' }];
    const r = { request_type: '재등원요청', target_class_code: 'A103', return_date: '2026-04-21' };
    const { studentUpdate } = buildUpdate(r, stu, cs, allStudents);
    expect(studentUpdate.name).toBe('김철수2');
  });
});

describe('buildUpdate — 퇴원요청', () => {
  it('withdrawal_date가 오늘 이하 → status=퇴원', () => {
    const r = { request_type: '퇴원요청', withdrawal_date: '2026-04-21' };
    const { studentUpdate, changeType } = buildUpdate(r, baseStu, {}, []);
    expect(changeType).toBe('WITHDRAW');
    expect(studentUpdate.status).toBe('퇴원');
    expect(studentUpdate.withdrawal_date).toBe('2026-04-21');
  });

  it('withdrawal_date가 미래 → pre_withdrawal_status 저장, status 유지', () => {
    const r = { request_type: '퇴원요청', withdrawal_date: '2026-05-15' };
    const stu = { ...baseStu, status: '실휴원' };
    const { studentUpdate } = buildUpdate(r, stu, {}, []);
    expect(studentUpdate.status).toBeUndefined();
    expect(studentUpdate.pre_withdrawal_status).toBe('실휴원');
    expect(studentUpdate.withdrawal_date).toBe('2026-05-15');
  });

  it('휴원→퇴원도 동일 동작', () => {
    const r = { request_type: '휴원→퇴원', withdrawal_date: '2026-04-21' };
    const stu = { ...baseStu, status: '실휴원', pause_start_date: '2026-04-01', pause_end_date: '2026-05-31' };
    const { studentUpdate } = buildUpdate(r, stu, {}, []);
    expect(studentUpdate.status).toBe('퇴원');
    // pause_* 필드는 finalize 단계에서 deleteField로 처리 (Task 1.9)
  });
});
