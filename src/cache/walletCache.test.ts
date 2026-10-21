import {
  assertSuccess,
  decodeHdPublicKey,
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  encodeHdPublicKey,
} from "@bitauth/libauth";

import { Config } from "../config.js";
import { IndexedDbCache } from "./IndexedDbCache.js";
import { HDWalletCache, parse, stringify } from "./walletCache.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function xpubAt(path: string): string {
  const root = deriveHdPrivateNodeFromBip39Mnemonic(MNEMONIC);
  const priv = deriveHdPath(root, path);
  if (typeof priv === "string") throw new Error(priv);
  const pub = deriveHdPublicNode(priv);
  return assertSuccess(encodeHdPublicKey({ node: pub, network: "mainnet" }))
    .hdPublicKey;
}

// the store HDWalletCache keeps its records in with Config.UseIndexedDBCache
async function getStoredItem(key: string): Promise<string | null> {
  const storage = new IndexedDbCache("WalletCache");
  await storage.init();
  try {
    return await storage.getItem(key);
  } finally {
    await storage.close();
  }
}

async function setStoredItem(key: string, value: string): Promise<void> {
  const storage = new IndexedDbCache("WalletCache");
  await storage.init();
  try {
    await storage.setItem(key, value);
  } finally {
    await storage.close();
  }
}

// a signing wallet's node: only those write a record
function privateNodeAt(path: string) {
  const node = deriveHdPath(
    deriveHdPrivateNodeFromBip39Mnemonic(MNEMONIC),
    path,
  );
  if (typeof node === "string") throw new Error(node);
  return node;
}

function publicNodeOf(xpub: string) {
  const decoded = decodeHdPublicKey(xpub);
  if (typeof decoded === "string") throw new Error(decoded);
  return decoded.node;
}

const ACCOUNT_PATH = "m/44'/145'/0'"; // depth 3
const CHANGE_PATH = "m/44'/145'/0'/0"; // depth 4 (external branch)

describe("HDWalletCache", () => {
  test("getByPath derives at the given relative path and caches the result", () => {
    const cache = new HDWalletCache(
      "wallet-acc",
      publicNodeOf(xpubAt(ACCOUNT_PATH)),
      "bitcoincash",
    );
    const first = cache.getByPath("0/0");
    const second = cache.getByPath("0/0");
    expect(second).toBe(first); // cached -- same reference

    const other = cache.getByPath("0/1");
    expect(other.address).not.toBe(first.address);
  });

  test("getByIndex is a wrapper around getByPath with the standard convention", () => {
    const cache = new HDWalletCache(
      "wallet-acc",
      publicNodeOf(xpubAt(ACCOUNT_PATH)),
      "bitcoincash",
    );
    expect(cache.getByIndex(0, 0).address).toBe(cache.getByPath("0/0").address);
    expect(cache.getByIndex(3, 1).address).toBe(cache.getByPath("1/3").address);
  });

  test("paths beyond branches 0/1 derive distinct addresses (N-branch support)", () => {
    const cache = new HDWalletCache(
      "wallet-acc",
      publicNodeOf(xpubAt(ACCOUNT_PATH)),
      "bitcoincash",
    );
    const b0 = cache.getByPath("0/0").address;
    const b1 = cache.getByPath("1/0").address;
    const b7 = cache.getByPath("7/0").address;
    expect(b0).not.toBe(b1);
    expect(b0).not.toBe(b7);
    expect(b1).not.toBe(b7);
  });

  test("the cache is depth-agnostic: it derives the relative path it is given", () => {
    const accountCache = new HDWalletCache(
      "wallet-acc",
      publicNodeOf(xpubAt(ACCOUNT_PATH)),
      "bitcoincash",
    );
    const changeCache = new HDWalletCache(
      "wallet-chg",
      publicNodeOf(xpubAt(CHANGE_PATH)),
      "bitcoincash",
    );

    // The cache derives whatever relative path the caller asks for.
    for (const i of [0, 1, 5, 19]) {
      const fromAccount = accountCache.getByPath(`0/${i}`).address;
      const fromChange = changeCache.getByPath(`${i}`).address;
      expect(fromChange).toBe(fromAccount);
    }
  });

  test("reverse lookup: cache.get(address) returns the entry for any cached path", () => {
    const cache = new HDWalletCache(
      "wallet-chg",
      publicNodeOf(xpubAt(CHANGE_PATH)),
      "bitcoincash",
    );
    const entry = cache.getByPath("3");
    const found = cache.get(entry.address);
    expect(found?.address).toBe(entry.address);
    expect(found?.tokenAddress).toBe(entry.tokenAddress);
  });

  test("persists branches 0 and 1 in mainnet-js 3.1.7's form, and other paths in memory only", async () => {
    const prevIndexedDb = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    try {
      const node = privateNodeAt(ACCOUNT_PATH);

      const writer = new HDWalletCache(
        "wallet-persist",
        node,
        "bitcoincash",
        /* writeTimeout */ 0,
      );
      await writer.init();

      const a0 = writer.getByPath("0/0").address;
      const a1 = writer.getByPath("1/2").address;
      const a7 = writer.getByPath("7/5").address;
      const bare = writer.getByPath("3").address;
      expect(writer.get(a7)?.address).toBe(a7);
      expect(writer.get(bare)?.address).toBe(bare);
      await writer.persist(true);

      const stored = parse(
        (await getStoredItem("walletCache-wallet-persist"))!,
      );
      expect(Object.keys(stored)).toEqual(["walletCache", "indexCache"]);
      expect(Object.keys(stored.walletCache)).toEqual([
        "wallet-persist-0-false",
        "wallet-persist-2-true",
      ]);
      expect(stored.walletCache["wallet-persist-2-true"]).toMatchObject({
        address: a1,
        index: 2,
        change: true,
      });
      expect(stored.indexCache).toEqual({
        [a0]: { index: 0, change: false },
        [a1]: { index: 2, change: true },
      });

      const reader = new HDWalletCache("wallet-persist", node, "bitcoincash");
      await reader.init();
      expect(reader.get(a0)?.address).toBe(a0);
      expect(reader.get(a1)?.address).toBe(a1);
      expect(reader.get(a7)).toBeUndefined();
      expect(reader.get(bare)).toBeUndefined();
    } finally {
      Config.UseIndexedDBCache = prevIndexedDb;
    }
  });

  test("loads a mainnet-js 3.1.7 record without writing, and writes back only its form", async () => {
    const prevIndexedDb = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    try {
      const node = privateNodeAt(ACCOUNT_PATH);
      const walletId = "wallet-3.1.7";
      const derived = new HDWalletCache("wallet-derived", node, "bitcoincash");
      const entry = {
        ...derived.getByPath("0/0"),
        index: 0,
        change: false,
        status: "status",
      };
      const nextEntry = derived.getByPath("0/1");

      const record = stringify({
        walletCache: {
          [`${walletId}-0-false`]: entry,
          // the form next.14 wrote, which 3.1.7 carried along unread
          [`${walletId}-0/1`]: nextEntry,
        },
        indexCache: { [entry.address]: { index: 0, change: false } },
      });
      await setStoredItem(`walletCache-${walletId}`, record);

      const cache = new HDWalletCache(walletId, node, "bitcoincash");
      await cache.init();
      expect(await getStoredItem(`walletCache-${walletId}`)).toBe(record);
      expect(cache.get(entry.address)?.status).toBe("status");
      expect(cache.getByPath("0/0").status).toBe("status");
      expect(cache.get(nextEntry.address)).toBeUndefined();

      await cache.persist(true);
      const stored = parse((await getStoredItem(`walletCache-${walletId}`))!);
      expect(stored).toEqual({
        walletCache: { [`${walletId}-0-false`]: parse(stringify(entry)) },
        indexCache: { [entry.address]: { index: 0, change: false } },
      });
    } finally {
      Config.UseIndexedDBCache = prevIndexedDb;
    }
  });

  test("a watch-only cache reads and writes no record", async () => {
    const prevIndexedDb = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    try {
      const walletId = "wallet-watch-only";
      const signing = new HDWalletCache(
        "wallet-signing",
        privateNodeAt(ACCOUNT_PATH),
        "bitcoincash",
      );
      const record = stringify({
        walletCache: { [`${walletId}-0-false`]: signing.getByPath("0/0") },
        indexCache: {},
      });
      await setStoredItem(`walletCache-${walletId}`, record);

      const cache = new HDWalletCache(
        walletId,
        publicNodeOf(xpubAt(ACCOUNT_PATH)),
        "bitcoincash",
      );
      await cache.init();
      expect(cache.getByPath("0/0").privateKey).toBeUndefined();
      expect(cache.getByPath("0/0").address).toBe(
        signing.getByPath("0/0").address,
      );
      await cache.persist(true);
      expect(await getStoredItem(`walletCache-${walletId}`)).toBe(record);
    } finally {
      Config.UseIndexedDBCache = prevIndexedDb;
    }
  });

  test("usedLength counts addresses with a stored status, up to a bound", () => {
    const cache = new HDWalletCache(
      "wallet-acc",
      publicNodeOf(xpubAt(ACCOUNT_PATH)),
      "bitcoincash",
    );
    cache.getByIndex(9, 0);
    for (const [index, branch] of [
      [4, 0],
      [2, 1],
    ]) {
      const { address } = cache.getByIndex(index, branch);
      cache.setStatusAndUtxos(address, "status", [], [], 0);
    }
    expect(cache.usedLength(0)).toBe(5);
    expect(cache.usedLength(1)).toBe(3);
    expect(cache.usedLength(7)).toBe(0);

    // an entry missing its status is not used, and a damaged index is cut to the bound
    (cache.getByIndex(30, 0) as any).status = undefined;
    cache.getByIndex(10_000_000, 1).status = "status";
    expect(cache.usedLength(0)).toBe(5);
    expect(cache.usedLength(1)).toBe(2000);
  });

  test("get() returns only the entry of the address asked for", async () => {
    const prevIndexedDb = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    try {
      const node = privateNodeAt(ACCOUNT_PATH);
      const walletId = "wallet-bad-index";
      const other = new HDWalletCache("wallet-other", node, "bitcoincash");
      const stranger = other.getByPath("0/5").address;
      await setStoredItem(
        `walletCache-${walletId}`,
        stringify({
          walletCache: {},
          indexCache: { [stranger]: { index: 0, change: false } },
        }),
      );

      const cache = new HDWalletCache(walletId, node, "bitcoincash");
      await cache.init();
      expect(cache.get(stranger)).toBeUndefined();
    } finally {
      Config.UseIndexedDBCache = prevIndexedDb;
    }
  });
});

describe("a debounced write that fails", () => {
  test("is not left as an unhandled rejection", async () => {
    const prevIndexedDb = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    let writes = 0;
    // not vi.spyOn: a spy handles the promises it returns, which would hide the rejection
    const failWrites = (cache: object) => {
      (cache as any)._storage.setItem = async () => {
        writes++;
        throw new Error("storage full");
      };
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const node = privateNodeAt(ACCOUNT_PATH);
      const hd = new HDWalletCache(
        "wallet-write-fails",
        node,
        "bitcoincash",
        1,
      );
      await hd.init();
      failWrites(hd);
      const entry = hd.getByPath("0/0");
      hd.setStatusAndUtxos(entry.address, "status", [], [], 0);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writes).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      Config.UseIndexedDBCache = prevIndexedDb;
    }
  });
});
