import { HttpsError } from 'firebase-functions/v2/https';
import { generateText } from './vertex.js';
import { writeLog } from './notifyLog.js';
import { assertAuthorizedStaff } from './authGuards.js';

const DEFAULT_MODEL = 'gemini-3.5-flash';
const ALLOWED_MODELS = new Set([
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
]);
const MAX_PROMPT_CHARS = 50000;

// per-uid 호출 빈도 제한(비용 악용 방어, H-02). 인스턴스 내 슬라이딩 윈도우 —
// maxInstances 환경에선 인스턴스당 한도이므로 1차 방어선이다(외부계정 차단은 assertAuthorizedStaff가 담당).
// 교차 인스턴스 강제와 App Check는 호출자(DSC) App Check 도입 후 G12에서 강화.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const _rateCalls = new Map();

// 테스트 전용 — 모듈 상태 초기화.
export function resetRateLimits() {
  _rateCalls.clear();
}

function assertWithinRateLimit(uid, now = Date.now()) {
  const recent = (_rateCalls.get(uid) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    throw new HttpsError('resource-exhausted', 'AI 호출 빈도 제한을 초과했습니다. 잠시 후 다시 시도하세요.');
  }
  recent.push(now);
  _rateCalls.set(uid, recent);
}

// 로깅 실패가 제품 경로(생성 성공/실패)를 가리지 않도록 non-fatal.
async function safeLog(entry) {
  try {
    await writeLog(entry);
  } catch (logErr) {
    console.warn('[llmGenerate] writeLog 실패:', String(logErr?.message || logErr));
  }
}

// Vertex/SDK 에러를 호출자가 재시도 판정할 수 있는 HttpsError code로 매핑.
// @google/genai ApiError는 status(숫자) 또는 메시지에 상태코드를 담는다.
function classifyLlmError(err) {
  const status = err?.status ?? err?.code;
  const msg = String(err?.message || err);
  const is = (n) => status === n || new RegExp(`\\b${n}\\b`).test(msg);
  if (is(429) || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return new HttpsError('resource-exhausted', 'AI 사용량 한도 초과');
  }
  if (is(503) || is(502) || is(504) || /UNAVAILABLE/i.test(msg)) {
    return new HttpsError('unavailable', 'AI 일시적 사용 불가');
  }
  return new HttpsError('internal', 'AI 생성 실패');
}

export async function handleLlmGenerate(request) {
  // 직원(학원 도메인) 인증 — 외부 Firebase 계정의 유료 호출 차단(H-02).
  assertAuthorizedStaff(request.auth);
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

  // 비용 경로 직전에만 빈도 슬롯 소비 — 무효(zero-cost) 요청으로 자기 잠금 방지.
  assertWithinRateLimit(request.auth.uid);

  try {
    const text = await generateText(useModel, prompt, config ?? {});
    await safeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: true });
    return { text, model: useModel };
  } catch (err) {
    await safeLog({ channel: 'llm', uid: request.auth.uid, model: useModel, ok: false, error: String(err?.message || err) });
    throw classifyLlmError(err);
  }
}
