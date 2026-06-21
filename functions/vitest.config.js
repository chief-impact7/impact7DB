import { defineConfig } from 'vitest/config';

// 통합 테스트(*.integration.test.js)가 같은 emulator/projectId·컬렉션을 공유하므로
// 파일 병렬을 끈다 — 동시 beforeEach 삭제가 서로의 fixture를 지우는 경쟁 방지(M-08).
export default defineConfig({
  test: { fileParallelism: false },
});
