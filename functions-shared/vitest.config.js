import { defineConfig, configDefaults } from 'vitest/config';

// attendanceState 순수 모듈은 node:test로 검증한다(`node --test test/attendanceState.test.js`).
// vitest는 node:test 형식을 수집할 수 없으므로 전체 `vitest run`에서만 제외한다.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/attendanceState.test.js'],
  },
});
