import { describe, expect, it } from 'vitest';
import {
  ALIMTALK_MAX_CHARS,
  LMS_MAX_BYTES,
  assertAlimtalkPayloadFits,
  assertSmsTextFits,
  smsByteLength,
  splitSmsText,
} from '../src/messageLength.js';
import { buildSmsQueueDocs } from '../src/smsQueueDoc.js';

describe('message length limits', () => {
  it('counts ASCII as 1 byte, Korean as 2 bytes, and supplementary characters as 4 bytes', () => {
    expect(smsByteLength('A 한')).toBe(4);
    expect(smsByteLength('😀')).toBe(4);
  });

  it('allows exact limits and rejects one over', () => {
    expect(() => assertSmsTextFits('a'.repeat(LMS_MAX_BYTES))).not.toThrow();
    expect(() => assertSmsTextFits('a'.repeat(LMS_MAX_BYTES + 1))).toThrow('현재 2001byte');
    expect(() => assertAlimtalkPayloadFits('가'.repeat(ALIMTALK_MAX_CHARS), 'a'.repeat(LMS_MAX_BYTES))).not.toThrow();
    expect(() => assertAlimtalkPayloadFits('가'.repeat(ALIMTALK_MAX_CHARS + 1), '안내')).toThrow('현재 1001자');
  });

  it('splits long text into numbered LMS-safe parts', () => {
    const parts = splitSmsText('가'.repeat(1600));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^\[1\/2\] /);
    expect(parts[1]).toMatch(/^\[2\/2\] /);
    expect(parts.every((part) => smsByteLength(part) <= LMS_MAX_BYTES)).toBe(true);
  });

  it('does not create an extra part before a token that must itself be split', () => {
    const parts = splitSmsText(`안내 ${'가'.repeat(1001)}`);
    expect(parts).toHaveLength(2);
    expect(parts.every((part) => smsByteLength(part) <= LMS_MAX_BYTES)).toBe(true);
  });

  it('preserves whitespace at split boundaries', () => {
    const source = `${'가'.repeat(990)}\n\n${'나'.repeat(20)}`;
    const parts = splitSmsText(source);
    const restored = parts.map((part) => part.replace(/^\[\d+\/\d+\] /, '')).join('');
    expect(restored).toBe(source);
  });

  it('adds split metadata to queue documents', () => {
    const docs = buildSmsQueueDocs(
      { phone: '01011112222', content: '가'.repeat(1600) },
      { splitLongMessage: true, splitGroupId: 'report:s1:parent_1' },
    );
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      split_group_id: 'report:s1:parent_1',
      split_part_index: 1,
      split_part_total: 2,
    });
  });
});
