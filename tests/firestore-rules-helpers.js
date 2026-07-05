import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, '..', 'firestore.rules');

// 파일별 고유 projectId로 격리 — 같은 emulator를 공유하는 여러 테스트 파일이
// clearFirestore로 서로의 데이터를 지우는 경쟁을 방지(M-08).
export async function createTestEnv(projectId = 'impact7db-rules-test') {
  return await initializeTestEnvironment({
    projectId,
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

// 외부(비 impact7) 도메인 인증 컨텍스트 — 조직 정책 완화로 외부 구글 계정도 토큰을 얻을 수 있음.
export function externalCtx(env, uid = 'ext1', email = 'attacker@gmail.com') {
  return env.authenticatedContext(uid, { email, email_verified: true }).firestore();
}
