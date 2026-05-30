import { describe, it, expect } from 'vitest';
import { computeLabelUpdate } from '../src/studentLabelSync.js';

describe('computeLabelUpdate', () => {
  it('라벨이 바뀌면 update 반환', () => {
    expect(computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여자중학교', school_level_grade: '구값' }))
      .toEqual({ school: '봉영여자중학교', school_level_grade: '봉영여중1' });
  });
  it('라벨이 같으면 null (무한루프 방지)', () => {
    expect(computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '봉영여중', school_level_grade: '봉영여중1' }))
      .toBeNull();
  });
  it('school 미러 + label 둘 다 갱신', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '구값', school_level_grade: '구값' });
    expect(r).toEqual({ school: '봉영여중', school_level_grade: '봉영여중1' });
  });
  it('둘 다 같으면 null', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '봉영여중', school_level_grade: '봉영여중1' });
    expect(r).toBeNull();
  });
  it('currentSchool 빈값이면 null (미마이그레이션 보호)', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school: '봉영여중', school_level_grade: '봉영여중1' });
    expect(r).toBeNull();
  });
});
