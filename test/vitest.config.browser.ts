import { playwright } from "@vitest/browser-playwright";
import dotenv from "dotenv";
import path from "path";
import { defineConfig } from "vitest/config";

const root = path.resolve(import.meta.dirname, "..");

// Load env vars before define so they're available at config time
dotenv.config({ path: path.resolve(root, ".env.regtest"), quiet: true });
try {
  dotenv.config({ path: path.resolve(root, ".env.testnet"), quiet: true });
} catch {}

export default defineConfig({
  resolve: {
    alias: {
      "#test": path.resolve(import.meta.dirname),
    },
  },
  define: {
    "process.env.USE_MOCK_PROVIDER": JSON.stringify(
      process.env.USE_MOCK_PROVIDER || "",
    ),
    "process.env.ADDRESS": JSON.stringify(process.env.ADDRESS || ""),
    "process.env.PRIVATE_WIF": JSON.stringify(process.env.PRIVATE_WIF || ""),
    "process.env.ALICE_ID": JSON.stringify(process.env.ALICE_ID || ""),
    "process.env.ALICE_TESTNET_ADDRESS": JSON.stringify(
      process.env.ALICE_TESTNET_ADDRESS || "",
    ),
    "process.env.ALICE_TESTNET_WALLET_ID": JSON.stringify(
      process.env.ALICE_TESTNET_WALLET_ID || "",
    ),
    "process.env.ELECTRUM_REGTEST": JSON.stringify(
      process.env.ELECTRUM_REGTEST || "",
    ),
  },
  test: {
    root,
    globals: true,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotDirectory: path.resolve(import.meta.dirname, "screenshots"),
    },
    include: ["src/**/*.test.browser.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: [path.resolve(import.meta.dirname, "vitest.global-setup.cjs")],
    attachmentsDir: path.resolve(import.meta.dirname, "attachments"),
    fileParallelism: false,
    testTimeout: 95000,
  },
});
