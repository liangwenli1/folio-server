import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All files share one test database, so they run one after another.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
});
