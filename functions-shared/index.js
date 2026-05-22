import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { generateText } from './src/vertex.js';
import { writeLog } from './src/notifyLog.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

const DEFAULT_MODEL = 'gemini-2.5-flash';
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
]);

export const llmGenerate = onCall(
  { enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const { prompt, model, config } = request.data ?? {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new HttpsError('invalid-argument', 'prompt(문자열)가 필요합니다.');
    }
    const useModel = model && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

    try {
      const text = await generateText(useModel, prompt, config ?? {});
      await writeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: true });
      return { text, model: useModel };
    } catch (err) {
      await writeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: false, error: String(err?.message || err) });
      throw new HttpsError('internal', 'AI 생성 실패');
    }
  }
);

export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);
