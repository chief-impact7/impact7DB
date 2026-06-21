import { defineConfig } from 'vitest/config';

// attendanceState 포함 모든 테스트를 vitest가 수집한다(과거 node:test 고아 → vitest 전환, M-08).
export default defineConfig({
  test: {},
});
