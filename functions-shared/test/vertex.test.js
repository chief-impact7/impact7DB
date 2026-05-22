import { describe, it, expect, vi } from 'vitest';

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: vi.fn().mockResolvedValue({ text: 'hello' }) },
  })),
}));

describe('generateText', () => {
  it('returns model text', async () => {
    const { generateText } = await import('../src/vertex.js');
    const out = await generateText('gemini-2.5-flash', 'hi', {});
    expect(out).toBe('hello');
  });
});
