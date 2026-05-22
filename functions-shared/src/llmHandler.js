import { HttpsError } from 'firebase-functions/v2/https';
import { generateText } from './vertex.js';
import { writeLog } from './notifyLog.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
]);
const MAX_PROMPT_CHARS = 50000;

// 로깅 실패가 제품 경로(생성 성공/실패)를 가리지 않도록 non-fatal.
async function safeLog(entry) {
  try {
    await writeLog(entry);
  } catch (logErr) {
    console.warn('[llmGenerate] writeLog 실패:', String(logErr?.message || logErr));
  }
}

export async function handleLlmGenerate(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const { prompt, model, config } = request.data ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new HttpsError('invalid-argument', 'prompt(문자열)가 필요합니다.');
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new HttpsError('invalid-argument', `prompt가 너무 깁니다(최대 ${MAX_PROMPT_CHARS}자).`);
  }
  if (config != null && typeof config !== 'object') {
    throw new HttpsError('invalid-argument', 'config는 객체여야 합니다.');
  }
  const useModel = model && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

  try {
    const text = await generateText(useModel, prompt, config ?? {});
    await safeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: true });
    return { text, model: useModel };
  } catch (err) {
    await safeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: false, error: String(err?.message || err) });
    throw new HttpsError('internal', 'AI 생성 실패');
  }
}
