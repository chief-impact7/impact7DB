import { describe, it, expect } from 'vitest';
import { replaceRegularEnrollment } from '../src/enrollments.js';

const today = '2026-04-21';

describe('replaceRegularEnrollment', () => {
  it('정규만 교체하고 내신/특강 보존', () => {
    const stu = {
      enrollments: [
        { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월', '금'] },
        { class_type: '내신', class_number: '103', day: ['화', '목', '토'], end_date: '2026-05-03' },
        { class_type: '특강', class_number: '수요특강', day: ['수'] },
      ],
    };
    const cs = { A103: { default_days: ['월', '수'] } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result).toHaveLength(3);
    const reg = result.find(e => e.class_type === '정규');
    expect(reg).toEqual({
      class_type: '정규',
      level_symbol: 'A',
      class_number: '103',
      day: ['월', '수'],
      start_date: today,
    });
    expect(result.find(e => e.class_type === '내신')).toBeDefined();
    expect(result.find(e => e.class_type === '특강')).toBeDefined();
  });

  it('class_type 없는 레거시 정규 enrollment도 교체 대상', () => {
    const stu = {
      enrollments: [
        { level_symbol: 'A', class_number: '101', day: ['월', '금'] },
      ],
    };
    const cs = { A103: { schedule: { 월: '17:00', 수: '17:00' } } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result).toHaveLength(1);
    expect(result[0].class_type).toBe('정규');
    expect(result[0].class_number).toBe('103');
    expect(result[0].day).toEqual(['월', '수']);
  });

  it('targetCode 없으면 기존 enrollments 그대로 반환', () => {
    const stu = {
      enrollments: [{ class_type: '정규', class_number: '101', day: ['월'] }],
    };
    const result = replaceRegularEnrollment(stu, '', today, {});
    expect(result).toEqual(stu.enrollments);
  });

  it('class_settings 누락 시 day는 빈 배열', () => {
    const stu = { enrollments: [{ class_type: '정규', class_number: '101', day: ['월'] }] };
    const result = replaceRegularEnrollment(stu, 'B201', today, {});
    expect(result[0].day).toEqual([]);
  });

  it('default_days가 schedule보다 우선', () => {
    const stu = { enrollments: [] };
    const cs = { A103: { default_days: ['월', '수'], schedule: { 화: '17:00' } } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result[0].day).toEqual(['월', '수']);
  });

  it('enrollments 배열이 없는 학생도 처리', () => {
    const stu = {};
    const cs = { A103: { default_days: ['월'] } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result).toHaveLength(1);
    expect(result[0].class_type).toBe('정규');
  });
});
