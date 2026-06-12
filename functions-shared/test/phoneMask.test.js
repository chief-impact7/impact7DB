import { describe, it, expect } from 'vitest';
import { maskPhone } from '../src/phoneMask.js';

describe('maskPhone', () => {
  it('formats as ***-****-뒤4자리', () => {
    expect(maskPhone('01012345678')).toBe('***-****-5678');
    expect(maskPhone('010-1234-5678')).toBe('***-****-5678');
    expect(maskPhone('0226490509')).toBe('***-****-0509');
  });

  it('returns empty string for blank input', () => {
    expect(maskPhone('')).toBe('');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });
});
