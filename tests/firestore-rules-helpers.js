import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import fs from 'node:fs';

const PROJECT_ID = 'impact7db-rules-test';

export async function createTestEnv() {
  return await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync('firestore.rules', 'utf8'),
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
