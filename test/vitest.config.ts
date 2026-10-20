import path from "path";
import { defineConfig } from "vitest/config";

const root = path.resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@rpckit/websocket/electrum-cash": path.resolve(
        root,
        "node_modules/@rpckit/websocket/dist/electrum-cash/index.js",
      ),
      "@rpckit/fallback/electrum-cash": path.resolve(
        root,
        "node_modules/@rpckit/fallback/dist/electrum-cash/index.js",
      ),
      "#test": path.resolve(__dirname),
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
      path.resolve(__dirname, "mock.setup.cjs"),
    ],
    globalSetup: [path.resolve(__dirname, "vitest.global-setup.cjs")],
    attachmentsDir: path.resolve(__dirname, "attachments"),
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
