import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/benchmark/test/*.test.ts"],
    // Integration scenarios spawn git, which spawns a Node filter per file.
    testTimeout: 120_000,
    // beforeAll builds a repository the same way, so it needs the same allowance.
    hookTimeout: 120_000,
  },
});
