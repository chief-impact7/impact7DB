import { describe, expect, it } from 'vitest';
import { activeTeacherLocals, isEligibleEmail } from '../src/teacherDirectory.js';

describe('activeTeacherLocals', () => {
  it('교수부 재직자의 영어이름 첫 토큰(소문자)만 모은다', () => {
    const locals = activeTeacherLocals([
      { department: '교수', englishName: 'Rachel', status: 'active' },
      { department: '교수', englishName: 'Edward Lee', status: 'active' },
      { department: '교수', englishName: 'Mike', status: 'terminated' },
      { department: '행정', englishName: 'Jane', status: 'active' },
      { department: '교수', englishName: '', status: 'active' },
    ]);
    expect([...locals].sort()).toEqual(['edward', 'rachel']);
  });
});

describe('isEligibleEmail', () => {
  const locals = new Set(['rachel', 'edward']);
  it('구·신 메일 모두 로컬파트로 매칭한다', () => {
    expect(isEligibleEmail('rachel@impact7.kr', locals)).toBe(true);
    expect(isEligibleEmail('rachel@gw.impact7.kr', locals)).toBe(true);
    expect(isEligibleEmail('Edward@impact7.kr', locals)).toBe(true);
  });
  it('비교수부·퇴직·빈값은 자격 없음', () => {
    expect(isEligibleEmail('chief@impact7.kr', locals)).toBe(false);
    expect(isEligibleEmail('', locals)).toBe(false);
    expect(isEligibleEmail(undefined, locals)).toBe(false);
  });
});
