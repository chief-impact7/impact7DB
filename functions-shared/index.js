import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { handleLlmGenerate } from './src/llmHandler.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// App Check은 후속 과제: 현재 유일 호출자인 DSC가 App Check 미설정이라 false로 시작.
// 호출자 보호는 handleLlmGenerate의 request.auth(로그인 직원만)로 유지.
export const llmGenerate = onCall({ enforceAppCheck: false }, handleLlmGenerate);

export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);
