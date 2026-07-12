import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    isolate: true,
    reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["default"],
    coverage: {
      provider: "v8",
      include: ["extensions/claude-style-subagent/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 75,
        branches: 60,
        functions: 70,
        lines: 75,
      },
    },
  },
});
