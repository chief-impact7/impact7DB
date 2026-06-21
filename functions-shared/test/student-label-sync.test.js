import { describe, it, expect } from 'vitest';
import { computeLabelUpdate } from '../src/studentLabelSync.js';

describe('computeLabelUpdate', () => {
  it('라벨이 바뀌면 update 반환 (school 미러 없이 school_level_grade만)', () => {
    expect(computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여자중학교', school_level_grade: '구값' }))
      .toEqual({ school_level_grade: '봉영여중1' });
  });
  it('라벨이 같으면 null (무한루프 방지)', () => {
    expect(computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '봉영여중', school_level_grade: '봉영여중1' }))
      .toBeNull();
  });
  it('school 미러는 중단 — label만 갱신(school_* SSoT)', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '구값', school_level_grade: '구값' });
    expect(r).toEqual({ school_level_grade: '봉영여중1' });
  });
  it('둘 다 같으면 null', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school_middle: '봉영여중', school: '봉영여중', school_level_grade: '봉영여중1' });
    expect(r).toBeNull();
  });
  it('진학 예측(고 학교 없음)도 라벨 생성 — 학부 필드 하나라도 있으면', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 7, school_middle: '봉영여', school_level_grade: '구값' });
    expect(r.school_level_grade).toBe('고(졸업+1)');
  });
  it('학부별 필드 전무 → null (미마이그레이션만 skip)', () => {
    const r = computeLabelUpdate({ level: '중등', grade: 1, school: '봉영여중', school_level_grade: '봉영여중1' });
    expect(r).toBeNull();
  });
});
