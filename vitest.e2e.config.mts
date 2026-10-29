import { defineConfig } from "vitest/config";

process.env.RUN_E2E = "1";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Only E2E tests — no vscode mock needed
    include: ["src/test/e2e/**/*.test.ts"],
    // E2E tests need generous timeouts for VS Code startup
    testTimeout: 45000,
    hookTimeout: 120000,
    // Each suite spawns a real VS Code instance — run files sequentially so
    // only one instance is alive at a time (parallel instances crash small
    // runners with Bus error / exhaust laptop memory).
    fileParallelism: false,
    // Deterministic file order. Vitest's default sequencer sorts by cached
    // result duration when a cache is present, so a previous run — or the unit
    // suite, which used to match these files — could reorder the suites and
    // make an IPC collision between them appear or vanish between runs. With
    // the cache off, order falls back to file size, which is stable.
    cache: false,
    sequence: { shuffle: false },
  },
});
