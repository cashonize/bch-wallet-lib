import { mkdtempSync } from "fs";
import { LocalStorage } from "node-localstorage";
import { tmpdir } from "os";
import path from "path";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { Config } from "../config.js";
import EncryptedStorageProvider from "../db/EncryptedStorageProvider.js";
import StorageProvider from "../db/StorageProvider.js";
import IndexedDBProvider from "../indexeddb/IndexedDBProvider.js";
import { BaseWallet, deleteNamedWallet } from "../wallet/Base.js";
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
  test("derives the cache id each HD wallet keys its cache record by", async () => {
    const hd = await RegTestHDWallet.fromSeed(MNEMONIC);
    const wallets: BaseWallet[] = [
      hd,
      await RegTestHDWallet.fromSeed(MNEMONIC, "m/44'/145'/1'"),
      await RegTestHDWallet.fromXPriv(hd.xPriv),
      await RegTestHDWallet.fromXPub(hd.xPub),
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
      expect(cacheIds.size).toBe(wallets.length);
    } finally {
      await Promise.all(wallets.map((wallet) => wallet.stop()));
    }
  });

  test("gives none for a single-address wallet, which keeps no cache record", async () => {
    const single = await RegTestWallet.fromSeed(MNEMONIC);
    const wallets: BaseWallet[] = [
      single,
      await RegTestWifWallet.fromWIF(single.privateKeyWif),
      await RegTestWallet.fromId(`privkey:regtest:${"11".repeat(32)}`),
      await RegTestWatchWallet.watchOnly(single.getDepositAddress()),
    ];
    try {
      for (const wallet of wallets) {
        expect(walletCacheIdFromWalletId(wallet.toDbString())).toBeUndefined();
      }
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
    test("deleteNamedWallet removes the wallet's row and its cache record, and only those", () =>
      withCacheBackend(backend, async (storage) => {
        const prevProvider = BaseWallet.StorageProvider;
        BaseWallet.StorageProvider = IndexedDBProvider;
        const dbName = `delete-named-${Math.random()}`;
        try {
          const hd = await RegTestHDWallet.named("hd", dbName);
          const single = await RegTestWallet.named("single", dbName);
          const kept = await RegTestHDWallet.named("kept", dbName);
          for (const wallet of [hd, single, kept]) {
            await wallet.walletCache.persist(true);
            await wallet.stop();
          }
          const hdKey = `walletCache-${cacheIdOf(hd)}`;
          const keptKey = `walletCache-${cacheIdOf(kept)}`;
          // what is at stake: the records hold the private keys
          expect(await storage.getItem(hdKey)).toContain("privateKey");
          // and the single-address wallet keeps none
          expect((await storage.keys()).sort()).toEqual(
            [hdKey, keptKey].sort(),
          );

          await deleteNamedWallet("hd", dbName);
          await deleteNamedWallet("single", dbName);
          await deleteNamedWallet("never-existed", dbName);

          expect(await storage.getItem(hdKey)).toBeNull();
          expect(await storage.getItem(keptKey)).not.toBeNull();
          const db = new IndexedDBProvider(dbName);
          await db.init();
          expect((await db.getWallets()).map((row) => row.name)).toEqual([
            "kept",
          ]);
          await db.close();
        } finally {
          BaseWallet.StorageProvider = prevProvider;
        }
      }));

    test("deleteNamedWallet purges the cache record of an encrypted row", () =>
      withCacheBackend(backend, async (storage) => {
        const prevProvider = BaseWallet.StorageProvider;
        BaseWallet.StorageProvider = EncryptedStorageProvider.wrapProvider(
          IndexedDBProvider,
          "passphrase",
          { iterations: 1 },
        ) as unknown as typeof StorageProvider;
        const dbName = `delete-encrypted-${Math.random()}`;
        try {
          const wallet = await RegTestHDWallet.named("hd", dbName);
          await wallet.walletCache.persist(true);
          await wallet.stop();
          const key = `walletCache-${cacheIdOf(wallet)}`;
          expect(await storage.getItem(key)).not.toBeNull();

          await deleteNamedWallet("hd", dbName);

          expect(await storage.getItem(key)).toBeNull();
        } finally {
          BaseWallet.StorageProvider = prevProvider;
        }
      }));

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
        const kept = await RegTestHDWallet.newRandom();
        await kept.walletCache.persist(true);
        await kept.stop();
        const keptKey = `walletCache-${cacheIdOf(kept)}`;
        const single = await RegTestWallet.newRandom();
        await single.stop();
        const orphanKey = `walletCache-${"ab".repeat(32)}`;
        await storage.setItem(orphanKey, "{}");
        await storage.setItem("txraw-regtest-cd", "00");

        // an id that cannot be read removes nothing
        await expect(
          pruneWalletCaches([kept.toDbString(), "enc:v1:abc:def"]),
        ).rejects.toThrow();
        expect(await storage.getItem(orphanKey)).not.toBeNull();

        await pruneWalletCaches([kept.toDbString(), single.toDbString()]);

        expect(await storage.getItem(orphanKey)).toBeNull();
        expect(await storage.getItem(keptKey)).not.toBeNull();
        expect(await storage.getItem("txraw-regtest-cd")).toBe("00");
      }));
  },
);
