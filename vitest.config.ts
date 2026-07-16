import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["code/**/*.test.ts", "code/**/*.test.tsx", "tests/**/*.test.ts"],
    exclude: ["code/cli/test/tmux/**", "code/web/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["code/**/*.ts", "code/**/*.tsx"],
      exclude: ["code/web/src/main.tsx", "**/*.config.ts"],
    },
    testTimeout: 15_000,
  },
});
