import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { handleLlmGenerate } from './src/llmHandler.js';

initializeApp();

setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

export const llmGenerate = onCall({ enforceAppCheck: true }, handleLlmGenerate);

export const healthCheck = onRequest(
  { invoker: 'public' },
  (req, res) => {
    res.json({ status: 'ok', codebase: 'shared', ts: Date.now() });
  }
);
