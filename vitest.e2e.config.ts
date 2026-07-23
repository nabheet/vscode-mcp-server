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
  },
});
