import { describe, it, expect } from 'vitest';
import { computeLabelUpdate } from '../src/studentLabelSync.js';

describe('computeLabelUpdate', () => {
  it('라벨이 바뀌면 update 반환', () => {
    expect(computeLabelUpdate({ school: '봉영여자중학교', level: '중등', grade: 1, school_level_grade: '구값' }))
      .toEqual({ school_level_grade: '봉영여중1' });
  });
  it('라벨이 같으면 null (무한루프 방지)', () => {
    expect(computeLabelUpdate({ school: '봉영여중', level: '중등', grade: 1, school_level_grade: '봉영여중1' }))
      .toBeNull();
  });
});
