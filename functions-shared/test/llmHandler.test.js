import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateTextMock = vi.fn();
const writeLogMock = vi.fn();

vi.mock('../src/vertex.js', () => ({
  generateText: (...args) => generateTextMock(...args),
}));
vi.mock('../src/notifyLog.js', () => ({
  writeLog: (...args) => writeLogMock(...args),
}));

const { handleLlmGenerate } = await import('../src/llmHandler.js');

beforeEach(() => {
  generateTextMock.mockReset();
  writeLogMock.mockReset();
  generateTextMock.mockResolvedValue('generated');
  writeLogMock.mockResolvedValue({ id: 'log1' });
});

const authReq = (data) => ({ auth: { uid: 'u1' }, data });

describe('handleLlmGenerate', () => {
  it('throws unauthenticated when request.auth is missing', async () => {
    await expect(handleLlmGenerate({ data: { prompt: 'hi' } })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('throws invalid-argument when prompt is not a string', async () => {
    await expect(handleLlmGenerate(authReq({ prompt: 123 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('throws invalid-argument when prompt is blank', async () => {
    await expect(handleLlmGenerate(authReq({ prompt: '   ' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('throws invalid-argument when prompt exceeds 50000 chars', async () => {
    const longPrompt = 'a'.repeat(50001);
    await expect(handleLlmGenerate(authReq({ prompt: longPrompt }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('throws invalid-argument when config is a non-object', async () => {
    await expect(
      handleLlmGenerate(authReq({ prompt: 'hi', config: 'nope' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('falls back to gemini-3.5-flash for a disallowed model', async () => {
    const result = await handleLlmGenerate(authReq({ prompt: 'hi', model: 'gpt-4' }));
    expect(generateTextMock).toHaveBeenCalledWith('gemini-3.5-flash', 'hi', {});
    expect(result.model).toBe('gemini-3.5-flash');
  });

  it('returns { text, model } and logs ok:true on success', async () => {
    const result = await handleLlmGenerate(
      authReq({ prompt: 'hi', model: 'gemini-3.1-pro-preview' }),
    );
    expect(result).toEqual({ text: 'generated', model: 'gemini-3.1-pro-preview' });
    expect(generateTextMock).toHaveBeenCalledWith('gemini-3.1-pro-preview', 'hi', {});
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'llm', uid: 'u1', model: 'gemini-3.1-pro-preview', ok: true }),
    );
  });

  it('throws internal and logs ok:false when generateText throws', async () => {
    generateTextMock.mockRejectedValue(new Error('vertex down'));
    await expect(handleLlmGenerate(authReq({ prompt: 'hi' }))).rejects.toMatchObject({
      code: 'internal',
    });
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'llm', uid: 'u1', ok: false, error: 'vertex down' }),
    );
  });

  it('still returns a normal response when writeLog throws (safeLog swallows)', async () => {
    writeLogMock.mockRejectedValue(new Error('firestore down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await handleLlmGenerate(authReq({ prompt: 'hi' }));
    expect(result).toEqual({ text: 'generated', model: 'gemini-3.5-flash' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('maps status 429 to resource-exhausted and logs ok:false', async () => {
    generateTextMock.mockRejectedValue(
      Object.assign(new Error('rate limited'), { status: 429 }),
    );
    await expect(handleLlmGenerate(authReq({ prompt: 'hi' }))).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'llm', uid: 'u1', ok: false }),
    );
  });

  it('maps a 503 status message to unavailable', async () => {
    generateTextMock.mockRejectedValue(new Error('got status: 503 Service Unavailable'));
    await expect(handleLlmGenerate(authReq({ prompt: 'hi' }))).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('maps a generic error to internal', async () => {
    generateTextMock.mockRejectedValue(new Error('something odd'));
    await expect(handleLlmGenerate(authReq({ prompt: 'hi' }))).rejects.toMatchObject({
      code: 'internal',
    });
  });
});
