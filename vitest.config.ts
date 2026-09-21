import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Integration scenarios spawn git, which spawns a Node filter per file.
    testTimeout: 120_000,
  },
});
