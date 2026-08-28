import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Only E2E tests — no vscode mock needed
    include: ['src/test/e2e/**/*.test.ts'],
    // E2E tests need generous timeouts for VS Code startup
    testTimeout: 45000,
    hookTimeout: 120000,
    // Each suite spawns a real VS Code instance — run files sequentially so
    // only one instance is alive at a time (parallel instances crash small
    // runners with Bus error / exhaust laptop memory).
    fileParallelism: false,
  },
});
