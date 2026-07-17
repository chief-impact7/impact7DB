import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// F7: 콜드스타트에 solapi SDK가 로드되지 않음을 import 체인으로 보장한다.
// index.js가 solapiProvider(solapi import)를 정적 import하지 않고 solapiSecrets만 쓰며,
// attendanceCheckin/getMessageDeliveryStatus 핸들러도 solapi/solapiProvider를 import하지 않는다.
// queueWorker만 실제 발송 시점에 동적 import로 solapiProvider를 로드한다.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

describe('cold start import chain (F7)', () => {
  it('index.js imports the solapi secrets from solapiSecrets.js, not solapiProvider.js', () => {
    const src = read('index.js');
    expect(src).toMatch(/from '\.\/src\/solapiSecrets\.js'/);
    expect(src).not.toMatch(/from '\.\/src\/solapiProvider\.js'/);
  });

  it('solapiSecrets.js does not import the solapi SDK', () => {
    const src = read('src/solapiSecrets.js');
    expect(src).not.toMatch(/from 'solapi'/);
  });

  it('checkin / delivery handlers do not import solapi or solapiProvider statically', () => {
    for (const file of ['src/checkinHandler.js', 'src/messageDeliveryHandler.js']) {
      const src = read(file);
      expect(src).not.toMatch(/from 'solapi'/);
      // 정적 import 금지 — queueWorker처럼 사용 시점 동적 import만 허용(잔액 조회).
      expect(src).not.toMatch(/^import .*solapiProvider/m);
    }
  });

  it('queueWorker loads solapiProvider only via dynamic import', () => {
    const src = read('src/queueWorker.js');
    expect(src).not.toMatch(/^import .*solapiProvider/m); // 정적 import 없음
    expect(src).toMatch(/await import\('\.\/solapiProvider\.js'\)/); // 동적 import만
  });
});
