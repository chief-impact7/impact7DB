import { describe, it, expect } from 'vitest';
import { parseClassCode } from '../src/classCode.js';

describe('parseClassCode', () => {
  it('영문+숫자 코드를 분리한다', () => {
    expect(parseClassCode('A103')).toEqual({ level_symbol: 'A', class_number: '103' });
  });
  it('숫자만 있는 코드는 level_symbol이 빈 문자열', () => {
    expect(parseClassCode('101')).toEqual({ level_symbol: '', class_number: '101' });
  });
  it('영문 prefix가 여러 글자인 코드도 처리', () => {
    expect(parseClassCode('AB103')).toEqual({ level_symbol: 'AB', class_number: '103' });
  });
  it('빈 문자열/null은 빈 결과', () => {
    expect(parseClassCode('')).toEqual({ level_symbol: '', class_number: '' });
    expect(parseClassCode(null)).toEqual({ level_symbol: '', class_number: '' });
  });
  it('소문자도 처리', () => {
    expect(parseClassCode('a103')).toEqual({ level_symbol: 'a', class_number: '103' });
  });
});
