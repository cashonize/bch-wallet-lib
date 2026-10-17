import { disconnectProviders, initProviders } from "#test/providers.js";
import { Config } from "../config.js";
import IndexedDBProvider from "../indexeddb/IndexedDBProvider.js";
import {
  BaseWallet,
  deleteNamedWallet,
  getStorageProvider,
} from "../wallet/Base.js";
import { RegTestHDWallet } from "../wallet/HDWallet.js";
import { RegTestWatchWallet } from "../wallet/Watch.js";
import { InvalidWalletIdError } from "../wallet/errors.js";
import { RegTestWallet } from "../wallet/Wif.js";
import { IndexedDbCache } from "./IndexedDbCache.js";
import { CacheProvider } from "./interface.js";
import {
  HDWalletCache,
  pruneWalletCaches,
  purgeWalletCache,
  walletCacheIdFromWalletId,
} from "./walletCache.js";

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

// an HD wallet whose discovery has settled and whose cache writes come 20 ms after a change
async function quickWritingWallet(walletId?: string): Promise<RegTestHDWallet> {
  let wallet: RegTestHDWallet;
  if (walletId) {
    wallet = await RegTestHDWallet.fromId(walletId);
  } else {
    wallet = await RegTestHDWallet.newRandom();
  }
  await wallet.getBalance();
  (wallet.walletCache as unknown as HDWalletCache).writeTimeout = 20;
  return wallet;
}

// a new random wallet stored under `name` in a database of its own, the row named() would write
async function storedIn<W extends BaseWallet>(
  walletClass: { newRandom(): Promise<W> },
  name: string,
  dbName: string,
): Promise<W> {
  const wallet = await walletClass.newRandom();
  const db = getStorageProvider(dbName)!;
  await db.init();
  try {
    await db.addWallet(name, wallet.toDbString());
  } finally {
    await db.close();
  }
  return wallet;
}

// longer than a debounced cache write takes to land
const afterDebouncedWrites = () =>
  new Promise((resolve) => setTimeout(resolve, 200));

// runs fn with the wallet caches in IndexedDB, as Cashonize keeps them
async function withIndexedDbCache(
  fn: (storage: CacheProvider) => Promise<void>,
) {
  const prevIndexedDb = Config.UseIndexedDBCache;
  Config.UseIndexedDBCache = true;
  const storage = new IndexedDbCache("WalletCache");
  await storage.init();
  try {
    await fn(storage);
  } finally {
    await storage.close();
    Config.UseIndexedDBCache = prevIndexedDb;
  }
}

describe("walletCacheIdFromWalletId", () => {
  test("derives the cache id each HD wallet keys its cache record by", async () => {
    const hd = await RegTestHDWallet.fromId(`hd:regtest:${MNEMONIC}`);
    const wallets: BaseWallet[] = [
      hd,
      await RegTestHDWallet.fromId(`hd:regtest:${MNEMONIC}:m/44'/145'/1'`),
      await RegTestHDWallet.fromId(`hd:regtest:${hd["xPriv"]}`),
      await RegTestHDWallet.fromId(`hd:regtest:${hd.xPub}`),
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
    const single = await RegTestWallet.fromId(`seed:regtest:${MNEMONIC}`);
    const wallets: BaseWallet[] = [
      single,
      await RegTestWallet.fromWIF(single.privateKeyWif),
      await RegTestWallet.fromId(`privkey:regtest:${"11".repeat(32)}`),
      await new RegTestWatchWallet()["watchOnly"](single.getDepositAddress()),
    ];
    try {
      for (const wallet of wallets) {
        expect(walletCacheIdFromWalletId(wallet.toDbString())).toBeUndefined();
      }
    } finally {
      await Promise.all(wallets.map((wallet) => wallet.stop()));
    }
  });

  test("throws InvalidWalletIdError for an id it cannot read, quoting no unknown part", () => {
    const failure = (walletId: string) => {
      try {
        walletCacheIdFromWalletId(walletId);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidWalletIdError);
        return error as InvalidWalletIdError;
      }
      throw new Error("expected a throw");
    };
    expect(failure("enc:v1:abc:def")).toMatchObject({
      reason: "network",
      kind: undefined,
    });
    expect(failure("named:regtest:alice")).toMatchObject({
      reason: "kind",
      kind: "named",
      message: "Unsupported wallet type 'named'",
    });
    expect(failure("hd:regtest")).toMatchObject({
      reason: "missing-value",
      kind: "hd",
    });
    expect(failure("")).toMatchObject({ reason: "network" });
    // a key in the type slot is not quoted
    const key = "L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ";
    const keyFailure = failure(`${key}:regtest:x`);
    expect(keyFailure.kind).toBeUndefined();
    expect(keyFailure.message).not.toContain(key);
  });
});

describe("wallet cache records in indexeddb", () => {
  test("deleteNamedWallet removes the wallet's row and its cache record, and only those", () =>
    withIndexedDbCache(async (storage) => {
      const prevProvider = BaseWallet.StorageProvider;
      BaseWallet.StorageProvider = IndexedDBProvider;
      const dbName = `delete-named-${Math.random()}`;
      try {
        const hd = await storedIn(RegTestHDWallet, "hd", dbName);
        const single = await storedIn(RegTestWallet, "single", dbName);
        const kept = await storedIn(RegTestHDWallet, "kept", dbName);
        for (const wallet of [hd, single, kept]) {
          await wallet.walletCache.persist(true);
          await wallet.stop();
        }
        const hdKey = `walletCache-${cacheIdOf(hd)}`;
        const keptKey = `walletCache-${cacheIdOf(kept)}`;
        // what is at stake: the records hold the private keys
        expect(await storage.getItem(hdKey)).toContain("privateKey");
        // and the single-address wallet keeps none
        expect((await storage.keys()).sort()).toEqual([hdKey, keptKey].sort());

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

  test("deleteNamedWallet keeps the row when the wallet id it holds cannot be read", () =>
    withIndexedDbCache(async () => {
      const prevProvider = BaseWallet.StorageProvider;
      BaseWallet.StorageProvider = IndexedDBProvider;
      const dbName = `delete-unreadable-${Math.random()}`;
      const db = new IndexedDBProvider(dbName);
      await db.init();
      try {
        await db.addWallet("alias", "named:regtest:other");

        await expect(deleteNamedWallet("alias", dbName)).rejects.toBeInstanceOf(
          InvalidWalletIdError,
        );

        expect(await db.walletExists("alias")).toBe(true);
      } finally {
        await db.close();
        BaseWallet.StorageProvider = prevProvider;
      }
    }));

  test("deleteNamedWallet keeps the row when the cache record cannot be removed", () =>
    withIndexedDbCache(async (storage) => {
      const prevProvider = BaseWallet.StorageProvider;
      BaseWallet.StorageProvider = IndexedDBProvider;
      const dbName = `delete-failing-${Math.random()}`;
      const removeItem = vi
        .spyOn(IndexedDbCache.prototype, "removeItem")
        .mockRejectedValue(new Error("storage unavailable"));
      try {
        const wallet = await storedIn(RegTestHDWallet, "hd", dbName);
        await wallet.stop();

        await expect(deleteNamedWallet("hd", dbName)).rejects.toThrow(
          "storage unavailable",
        );

        const db = new IndexedDBProvider(dbName);
        await db.init();
        expect(await db.walletExists("hd")).toBe(true);
        await db.close();
        removeItem.mockRestore();
        // and the row still leads to the record, so deleting again removes both
        await deleteNamedWallet("hd", dbName);
        expect(
          await storage.getItem(`walletCache-${cacheIdOf(wallet)}`),
        ).toBeNull();
      } finally {
        removeItem.mockRestore();
        BaseWallet.StorageProvider = prevProvider;
      }
    }));

  test("stop writes the cache's pending write, and a purge after it leaves no record", () =>
    withIndexedDbCache(async (storage) => {
      const wallet = await quickWritingWallet();
      const key = `walletCache-${cacheIdOf(wallet)}`;
      wallet.getDepositAddress(500); // a new entry, a write in 20 ms
      await wallet.stop();
      expect(await storage.getItem(key)).toContain(
        wallet.getDepositAddress(500),
      );

      await purgeWalletCache(wallet.toDbString());
      expect(await storage.getItem(key)).toBeNull();

      // the stopped wallet is still read, which writes nothing
      wallet.getDepositAddress(501);
      await afterDebouncedWrites();
      expect(await storage.getItem(key)).toBeNull();
    }));

  test("a purge while a write is pending leaves no record", () =>
    withIndexedDbCache(async (storage) => {
      const wallet = await quickWritingWallet();
      const key = `walletCache-${cacheIdOf(wallet)}`;
      try {
        await wallet.walletCache.persist(true);
        wallet.getDepositAddress(500); // a new entry, a write in 20 ms

        await purgeWalletCache(wallet.toDbString());
        await afterDebouncedWrites();

        expect(await storage.getItem(key)).toBeNull();
      } finally {
        await wallet.stop();
      }
      expect(await storage.getItem(key)).toBeNull();
    }));

  test("a purge while a write is in flight leaves no record", () =>
    withIndexedDbCache(async (storage) => {
      const wallet = await quickWritingWallet();
      const key = `walletCache-${cacheIdOf(wallet)}`;
      try {
        const write = wallet.walletCache.persist(true);
        await purgeWalletCache(wallet.toDbString());
        await write;

        expect(await storage.getItem(key)).toBeNull();
      } finally {
        await wallet.stop();
      }
    }));

  test("a running wallet writes no record after deleteNamedWallet, and one made later does", () =>
    withIndexedDbCache(async (storage) => {
      const prevProvider = BaseWallet.StorageProvider;
      BaseWallet.StorageProvider = IndexedDBProvider;
      const dbName = `delete-running-${Math.random()}`;
      const running = await storedIn(RegTestHDWallet, "hd", dbName);
      const walletId = running.toDbString();
      const key = `walletCache-${cacheIdOf(running)}`;
      let reopened: RegTestHDWallet | undefined;
      try {
        await running.getBalance();
        (running.walletCache as unknown as HDWalletCache).writeTimeout = 20;
        await running.walletCache.persist(true);

        await deleteNamedWallet("hd", dbName);
        expect(await storage.getItem(key)).toBeNull();

        // the running wallet still derives and caches new addresses, in memory only
        running.getDepositAddress(500);
        await running.walletCache.persist(true);
        await afterDebouncedWrites();
        expect(await storage.getItem(key)).toBeNull();

        // the same keys imported again are a wallet of their own, which caches as usual
        reopened = await quickWritingWallet(walletId);
        await reopened.walletCache.persist(true);
        expect(await storage.getItem(key)).toContain("privateKey");
      } finally {
        await running.stop();
        await reopened?.stop();
        await purgeWalletCache(walletId);
        BaseWallet.StorageProvider = prevProvider;
      }
    }));

  test("purgeWalletCache removes the record of a stored wallet id", () =>
    withIndexedDbCache(async (storage) => {
      const wallet = await RegTestHDWallet.newRandom();
      await wallet.walletCache.persist(true);
      await wallet.stop();
      const key = `walletCache-${cacheIdOf(wallet)}`;
      expect(await storage.getItem(key)).not.toBeNull();

      await purgeWalletCache(wallet.toDbString());

      expect(await storage.getItem(key)).toBeNull();
    }));

  test("pruneWalletCaches removes every wallet record but the kept ones", () =>
    withIndexedDbCache(async (storage) => {
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
});
