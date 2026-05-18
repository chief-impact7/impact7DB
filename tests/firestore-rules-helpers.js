import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT_ID = 'impact7db-rules-test';
const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, '..', 'firestore.rules');

export async function createTestEnv() {
  return await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
}

export function authedCtx(env, uid, email = `${uid}@impact7.kr`) {
  return env.authenticatedContext(uid, {
    email,
    email_verified: true,
  }).firestore();
}

export function unauthedCtx(env) {
  return env.unauthenticatedContext().firestore();
}
