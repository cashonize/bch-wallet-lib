import { mkdtempSync } from "fs";
import { LocalStorage } from "node-localstorage";
import { tmpdir } from "os";
import path from "path";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { Config } from "../config.js";
import { RegTestWallet } from "../wallet/Wif.js";
import { WebStorageCache } from "./WebStorageCache.js";

// a fresh localStorage of the given quota (in bytes), swapped in for the duration of fn; the
// shared one persists across runs on disk
async function withLocalStorage(quota: number, fn: () => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "localstorage-"));
  const original = globalThis.localStorage;
  globalThis.localStorage = new LocalStorage(dir, quota) as unknown as Storage;
  try {
    await fn();
  } finally {
    globalThis.localStorage = original;
  }
}

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe("WebStorageCache Tests", () => {
  test("test", async () => {
    const cache = new WebStorageCache();
    await cache.init();
    await cache.setItem("key", "value");
    const value = await cache.getItem("key");
    expect(value).toBe("value");

    await cache.removeItem("key");
    const value2 = await cache.getItem("key");
    expect(value2).toBeNull();
  });

  test("clear removes only the cache's own keys", () =>
    withLocalStorage(1024 * 1024, async () => {
      const cache = new WebStorageCache();
      await cache.init();
      localStorage.setItem("app-setting", "keep");
      localStorage.setItem("txraw-regtest-app", "keep too");
      await cache.setItem("txraw-regtest-aa", "00");
      await cache.setItems([
        ["txraw-regtest-bb", "01"],
        ["header-regtest-1-true", "{}"],
      ]);
      expect(localStorage.getItem("txraw-regtest-aa")).toBeNull();

      await cache.clear();

      expect(localStorage.getItem("app-setting")).toBe("keep");
      expect(localStorage.getItem("txraw-regtest-app")).toBe("keep too");
      const left = await cache.getItems([
        "txraw-regtest-aa",
        "txraw-regtest-bb",
        "header-regtest-1-true",
      ]);
      expect([...left.values()]).toEqual([null, null, null]);
    }));

  test("a full localStorage does not fail a write", async () => {
    await withLocalStorage(10, async () => {
      const cache = new WebStorageCache();
      await cache.setItem("key", "a value longer than the quota");
      await cache.setItems([["other", "another value longer than the quota"]]);
      expect(await cache.getItem("key")).toBeNull();
    });
  });

  test("a full localStorage does not fail a request whose result it caches", async () => {
    const wallet = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const utxo = (await wallet.getUtxos())[0];
    const prev = Config.UseLocalStorageCache;
    Config.UseLocalStorageCache = true;
    try {
      await withLocalStorage(10, async () => {
        const hex = await wallet.provider.getRawTransaction(utxo.txid);
        expect(typeof hex).toBe("string");
      });
    } finally {
      Config.UseLocalStorageCache = prev;
    }
  });
});
