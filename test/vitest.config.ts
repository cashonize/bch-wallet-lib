import path from "path";
import { defineConfig } from "vitest/config";

const root = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "#test": path.resolve(import.meta.dirname),
    },
  },
  test: {
    root,
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.test.browser.ts"],
    setupFiles: [
      "fake-indexeddb/auto",
      "node-localstorage/register",
      path.resolve(import.meta.dirname, "mock.setup.cjs"),
    ],
    globalSetup: [path.resolve(import.meta.dirname, "vitest.global-setup.cjs")],
    attachmentsDir: path.resolve(import.meta.dirname, "attachments"),
    testTimeout: 125000,
    fileParallelism: !!process.env.USE_MOCK_PROVIDER,
    coverage: {
      enabled: process.env.COVERAGE === "true",
      provider: "v8",
      reporter: ["lcov", "text"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/*.test.ts", "**/*.test.browser.ts"],
    },
  },
});
