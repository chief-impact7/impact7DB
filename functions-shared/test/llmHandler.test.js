import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateTextMock = vi.fn();
const writeLogMock = vi.fn();

vi.mock('../src/vertex.js', () => ({
  generateText: (...args) => generateTextMock(...args),
}));
vi.mock('../src/notifyLog.js', () => ({
  writeLog: (...args) => writeLogMock(...args),
}));

const { handleLlmGenerate, resetRateLimits } = await import('../src/llmHandler.js');

beforeEach(() => {
  generateTextMock.mockReset();
  writeLogMock.mockReset();
  generateTextMock.mockResolvedValue('generated');
  writeLogMock.mockResolvedValue({ id: 'log1' });
  resetRateLimits();
});

// 직원(학원 도메인) 인증 토큰 포함 — 보안 가드(assertAuthorizedStaff) 통과용.
const staffToken = { email: 'u1@impact7.kr', email_verified: true };
const authReq = (data) => ({ auth: { uid: 'u1', token: staffToken }, data });

describe('handleLlmGenerate', () => {
  it('throws unauthenticated when request.auth is missing', async () => {
    await expect(handleLlmGenerate({ data: { prompt: 'hi' } })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('throws permission-denied for external (non-impact7) domain accounts (H-02)', async () => {
    const ext = { auth: { uid: 'ext1', token: { email: 'attacker@gmail.com', email_verified: true } }, data: { prompt: 'hi' } };
    await expect(handleLlmGenerate(ext)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('throws permission-denied when email is not verified', async () => {
    const unverified = { auth: { uid: 'u1', token: { email: 'u1@impact7.kr', email_verified: false } }, data: { prompt: 'hi' } };
    await expect(handleLlmGenerate(unverified)).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('allows impact7 staff and calls generateText', async () => {
    const result = await handleLlmGenerate(authReq({ prompt: 'hi' }));
    expect(result.text).toBe('generated');
    expect(generateTextMock).toHaveBeenCalled();
  });

  it('enforces per-uid rate limit → resource-exhausted (H-02)', async () => {
    for (let i = 0; i < 30; i++) {
      await handleLlmGenerate(authReq({ prompt: 'hi' }));
    }
    await expect(handleLlmGenerate(authReq({ prompt: 'hi' }))).rejects.toMatchObject({
      code: 'resource-exhausted',
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
