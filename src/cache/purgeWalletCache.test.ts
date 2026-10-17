import { mkdtempSync } from "fs";
import { LocalStorage } from "node-localstorage";
import { tmpdir } from "os";
import path from "path";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { Config } from "../config.js";
import { BaseWallet } from "../wallet/Base.js";
import { RegTestHDWallet } from "../wallet/HDWallet.js";
import { RegTestWatchWallet } from "../wallet/Watch.js";
import { RegTestWallet, RegTestWifWallet } from "../wallet/Wif.js";
import { IndexedDbCache } from "./IndexedDbCache.js";
import { CacheProvider } from "./interface.js";
import {
  pruneWalletCaches,
  purgeWalletCache,
  walletCacheIdFromWalletId,
} from "./walletCache.js";
import { WebStorageCache } from "./WebStorageCache.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

function cacheIdOf(wallet: BaseWallet): string {
  return (wallet.walletCache as unknown as { walletId: string }).walletId;
}

// runs fn with the wallet caches in IndexedDB, as Cashonize keeps them, or in a fresh localStorage
async function withCacheBackend(
  backend: "indexeddb" | "localstorage",
  fn: (storage: CacheProvider) => Promise<void>,
) {
  const prevIndexedDb = Config.UseIndexedDBCache;
  const prevLocalStorage = Config.UseLocalStorageCache;
  const originalLocalStorage = globalThis.localStorage;
  let storage: CacheProvider;
  if (backend === "indexeddb") {
    Config.UseIndexedDBCache = true;
    storage = new IndexedDbCache("WalletCache");
  } else {
    Config.UseLocalStorageCache = true;
    const dir = mkdtempSync(path.join(tmpdir(), "localstorage-"));
    globalThis.localStorage = new LocalStorage(dir) as unknown as Storage;
    storage = new WebStorageCache();
  }
  await storage.init();
  try {
    await fn(storage);
  } finally {
    await storage.close();
    Config.UseIndexedDBCache = prevIndexedDb;
    Config.UseLocalStorageCache = prevLocalStorage;
    globalThis.localStorage = originalLocalStorage;
  }
}

describe("walletCacheIdFromWalletId", () => {
  test("derives the cache id each wallet type keys its cache record by", async () => {
    const hd = await RegTestHDWallet.fromSeed(MNEMONIC);
    const single = await RegTestWallet.fromSeed(MNEMONIC);
    const wallets: BaseWallet[] = [
      hd,
      await RegTestHDWallet.fromSeed(MNEMONIC, "m/44'/145'/1'"),
      await RegTestHDWallet.fromXPriv(hd.xPriv),
      await RegTestHDWallet.fromXPub(hd.xPub),
      single,
      await RegTestWallet.fromSeed(MNEMONIC, "m/44'/145'/0'/0/5"),
      await RegTestWifWallet.fromWIF(single.privateKeyWif),
      await RegTestWallet.fromId(`privkey:regtest:${"11".repeat(32)}`),
      await RegTestWatchWallet.watchOnly(single.getDepositAddress()),
    ];
    try {
      const cacheIds = new Set<string>();
      for (const wallet of wallets) {
        const cacheId = cacheIdOf(wallet);
        expect(
          walletCacheIdFromWalletId(wallet.toDbString()),
          wallet.toDbString(),
        ).toBe(cacheId);
        cacheIds.add(cacheId);
      }
      // the WIF and the watch-only wallet share the seed wallet's address, and so its record
      expect(cacheIds.size).toBe(wallets.length - 2);

      const payload = single.getDepositAddress().split(":")[1];
      expect(walletCacheIdFromWalletId(`watch:regtest:${payload}`)).toBe(
        cacheIdOf(single),
      );
    } finally {
      await Promise.all(wallets.map((wallet) => wallet.stop()));
    }
  });

  test("throws for an id it cannot read", () => {
    expect(() => walletCacheIdFromWalletId("enc:v1:abc:def")).toThrow();
    expect(() => walletCacheIdFromWalletId("named:regtest:alice")).toThrow();
    expect(() => walletCacheIdFromWalletId("")).toThrow();
  });
});

describe.each(["indexeddb", "localstorage"] as const)(
  "wallet cache records in %s",
  (backend) => {
    test("purgeWalletCache removes the record of a stored wallet id", () =>
      withCacheBackend(backend, async (storage) => {
        const wallet = await RegTestHDWallet.newRandom();
        await wallet.walletCache.persist(true);
        await wallet.stop();
        const key = `walletCache-${cacheIdOf(wallet)}`;
        expect(await storage.getItem(key)).not.toBeNull();

        await purgeWalletCache(wallet.toDbString());

        expect(await storage.getItem(key)).toBeNull();
      }));

    test("pruneWalletCaches removes every wallet record but the kept ones", () =>
      withCacheBackend(backend, async (storage) => {
        const kept = await RegTestWallet.newRandom();
        await kept.walletCache.persist(true);
        await kept.stop();
        const keptKey = `walletCache-${cacheIdOf(kept)}`;
        const orphanKey = `walletCache-${"ab".repeat(32)}`;
        await storage.setItem(orphanKey, "{}");
        await storage.setItem("txraw-regtest-cd", "00");

        // an id that cannot be read removes nothing
        await expect(
          pruneWalletCaches([kept.toDbString(), "enc:v1:abc:def"]),
        ).rejects.toThrow();
        expect(await storage.getItem(orphanKey)).not.toBeNull();

        await pruneWalletCaches([kept.toDbString()]);

        expect(await storage.getItem(orphanKey)).toBeNull();
        expect(await storage.getItem(keptKey)).not.toBeNull();
        expect(await storage.getItem("txraw-regtest-cd")).toBe("00");
      }));
  },
);
