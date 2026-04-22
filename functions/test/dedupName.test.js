import { describe, it, expect } from 'vitest';
import { deduplicateName } from '../src/dedupName.js';

describe('deduplicateName', () => {
  it('충돌 없으면 null 반환', () => {
    const others = [
      { id: 'b', name: '김철수', status: '재원' },
      { id: 'c', name: '이영희', status: '재원' },
    ];
    expect(deduplicateName('a', '박민수', others)).toBeNull();
  });

  it('단순 중복은 이름2로', () => {
    const others = [{ id: 'b', name: '김철수', status: '재원' }];
    expect(deduplicateName('a', '김철수', others)).toBe('김철수2');
  });

  it('이미 김철수와 김철수2가 있으면 김철수3', () => {
    const others = [
      { id: 'b', name: '김철수', status: '재원' },
      { id: 'c', name: '김철수2', status: '재원' },
    ];
    expect(deduplicateName('a', '김철수', others)).toBe('김철수3');
  });

  it('퇴원/종강 학생과는 충돌 안 함', () => {
    const others = [
      { id: 'b', name: '김철수', status: '퇴원' },
      { id: 'c', name: '김철수', status: '종강' },
    ];
    expect(deduplicateName('a', '김철수', others)).toBeNull();
  });

  it('자기 자신은 제외', () => {
    const others = [{ id: 'a', name: '김철수', status: '재원' }];
    expect(deduplicateName('a', '김철수', others)).toBeNull();
  });

  it('등원예정도 활성으로 간주', () => {
    const others = [{ id: 'b', name: '김철수', status: '등원예정' }];
    expect(deduplicateName('a', '김철수', others)).toBe('김철수2');
  });

  it('실휴원/가휴원도 활성으로 간주 (재원 전환 시 충돌 방지)', () => {
    const others = [
      { id: 'b', name: '김철수', status: '실휴원' },
      { id: 'c', name: '이영희', status: '가휴원' },
    ];
    expect(deduplicateName('a', '김철수', others)).toBe('김철수2');
    expect(deduplicateName('a', '이영희', others)).toBe('이영희2');
  });
});
