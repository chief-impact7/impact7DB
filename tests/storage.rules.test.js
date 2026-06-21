import { test, before, after, describe } from 'node:test';
import { assertSucceeds, assertFails, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { ref, uploadString, getBytes } from 'firebase/storage';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES = fs.readFileSync(join(__dirname, '..', 'storage.rules'), 'utf8');

// H-01: HR 경로(staff/contracts/expenses/signatures)는 callable 전용으로 잠겼다.
// exam(exam-papers/scans)·DSC(student-records)는 유지. storage emulator로 검증.
describe('storage.rules — HR callable 전환 잠금 (H-01)', () => {
  let env;
  before(async () => {
    env = await initializeTestEnvironment({
      projectId: 'rules-test-storage',
      storage: { rules: RULES, host: '127.0.0.1', port: 9199 },
    });
    await env.clearStorage();
  });
  after(async () => { await env?.cleanup(); });

  const staff = () => env.authenticatedContext('u1', { email: 'u1@impact7.kr', email_verified: true }).storage();
  const external = () => env.authenticatedContext('x1', { email: 'a@gmail.com', email_verified: true }).storage();
  const anon = () => env.unauthenticatedContext().storage();

  const img = { contentType: 'image/png' };

  // HR 경로 — 인증 직원도 직접 접근 거부(서버 callable 전용)
  for (const p of ['staff/s1/documents/f.pdf', 'contracts/o1/c1/contract_signed.pdf', 'expenses/e1/r.png', 'signatures/x.png']) {
    test(`${p}: 인증 직원 직접 write 거부`, async () => {
      await assertFails(uploadString(ref(staff(), p), 'data', 'raw', img));
    });
    test(`${p}: 인증 직원 직접 read 거부`, async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await uploadString(ref(ctx.storage(), p), 'seed', 'raw', img);
      });
      await assertFails(getBytes(ref(staff(), p)));
    });
  }

  // exam 경로 — impact7 직원 허용(회귀), 비인증 거부
  for (const p of ['exam-papers/x.png', 'scans/y.png']) {
    test(`${p}: impact7 직원 write 허용(회귀)`, async () => {
      await assertSucceeds(uploadString(ref(staff(), p), 'data', 'raw', img));
    });
    test(`${p}: 외부 도메인 write 거부`, async () => {
      await assertFails(uploadString(ref(external(), p), 'data', 'raw', img));
    });
    test(`${p}: 비인증 write 거부`, async () => {
      await assertFails(uploadString(ref(anon(), p), 'data', 'raw', img));
    });
  }

  // DSC student-records — 이미지 15MB 이하 허용(유지)
  test('student-records: 인증 직원 이미지 write 허용', async () => {
    await assertSucceeds(uploadString(ref(staff(), 'student-records/s1/r1/photo.png'), 'data', 'raw', img));
  });
  test('student-records: 비이미지 MIME 거부', async () => {
    await assertFails(uploadString(ref(staff(), 'student-records/s1/r1/doc.pdf'), 'data', 'raw', { contentType: 'application/pdf' }));
  });
});
