import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // E2E suites need a real VS Code instance; they run from
    // vitest.e2e.config.mts, which enables them via RUN_E2E.
    include: ["src/test/**/*.test.ts"],
    exclude: ["src/test/e2e/**"],
    // Mock vscode module globally
    setupFiles: ["./src/test/setup.ts"],
  },
});
