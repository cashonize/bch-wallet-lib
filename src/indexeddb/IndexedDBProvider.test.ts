import { disconnectProviders, initProviders } from "#test/providers.js";
import {
  BaseWallet,
  getNamedWalletId,
  namedWalletExists,
  HDWallet,
  RegTestWallet,
  TestNetWallet,
  Wallet,
} from "../index.js";
import { RegTestHDWallet } from "../wallet/HDWallet.js";
import { default as IndexedDBProvider } from "./IndexedDBProvider.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

test("Store and retrieve a Regtest wallet", async () => {
  let db = new IndexedDBProvider("regtest-db");
  await db.init();
  let w1 = await RegTestWallet.newRandom();
  w1.name = "dave";
  await db.addWallet(w1.name, w1.toDbString());
  let w2 = await db.getWallet("dave");
  expect(w1.name).toBe(w2!.name);
  expect(w1.toDbString()).toBe(w2!.wallet);
  await db.close();
});

test("Store and replace a Regtest wallet", async () => {
  const dbPrefix = `regtest2 ${Math.random()}`;
  let db = new IndexedDBProvider(dbPrefix);
  await db.init();

  expect(await db.walletExists("storereplace")).toBe(false);
  await db.addWallet("storereplace", "keep seed");
  let w2 = await db.getWallet("storereplace");
  expect("keep seed").toBe(w2!.wallet);
  expect(await db.walletExists("storereplace")).toBe(true);

  let seedId = (
    await RegTestWallet.fromId(
      "seed:regtest:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    )
  ).toDbString();
  await db.updateWallet("storereplace", seedId);
  let w4 = await db.getWallet("storereplace");
  expect(w4!.wallet).not.toBe("keep seed");
  expect(w4!.wallet).toBe(seedId);

  await db.updateWallet("storereplace_nonexistent", seedId);
  let w6 = await db.getWallet("storereplace_nonexistent")!;
  expect(w6).toBe(undefined);

  await db.close();
});

test("Store and retrieve a Testnet wallet", async () => {
  let db = new IndexedDBProvider("testnet-db");
  await db.init();
  // passing a name to newRandom should save the wallet,
  // but we want to save it manually in this case
  let w1 = await TestNetWallet.newRandom();
  w1.name = "dave";
  await db.addWallet(w1.name, w1.toDbString());
  let w2 = await db.getWallet("dave");
  expect(w1.name).toBe(w2!.name);
  expect(w1.toDbString()).toBe(w2!.wallet);
  await db.close();
});

test("Store and retrieve a Mainnet wallet", async () => {
  let db = new IndexedDBProvider("mainnet-db");
  await db.init();

  let w1 = await Wallet.newRandom();
  w1.name = "dave";
  await db.addWallet(w1.name, w1.toDbString());
  let w2 = await db.getWallet(w1.name);
  expect(w1.name).toBe(w2!.name);
  expect(w1.toDbString()).toBe(w2!.wallet);
  await db.close();
});

test("Store and retrieve a Mainnet wallet", async () => {
  BaseWallet.StorageProvider = IndexedDBProvider;

  let w1 = await Wallet.named("testWallet");
  let w2 = await Wallet.named("testWallet");
  expect(w1.getDepositAddress()).toBe(w2.getDepositAddress());
});

test("Store and retrieve a Mainnet hd wallet", async () => {
  BaseWallet.StorageProvider = IndexedDBProvider;

  const w1 = await HDWallet.named("test");
  const w2 = await HDWallet.named("test");
  expect(w1.mnemonic).toBe(w2.mnemonic);
});

test("deleteWallet removes a row and is a no-op when absent", async () => {
  const db = new IndexedDBProvider(`delete-${Math.random()}`);
  await db.init();
  await db.addWallet("alice", "wid-alice");
  expect(await db.walletExists("alice")).toBe(true);

  await db.deleteWallet("alice");
  expect(await db.walletExists("alice")).toBe(false);
  expect(await db.getWallet("alice")).toBeUndefined();

  // Missing names should not throw.
  await expect(db.deleteWallet("never-existed")).resolves.toBeUndefined();
  await db.close();
});

test("getNamedWalletId reads the mainnet database by default and returns undefined for a missing name", async () => {
  BaseWallet.StorageProvider = IndexedDBProvider;
  const name = `named-id-${Math.random()}`;
  const mainnetDb = new IndexedDBProvider("bitcoincash");
  await mainnetDb.init();
  await mainnetDb.addWallet(name, "wif:mainnet:stored-id");
  await mainnetDb.close();

  expect(await getNamedWalletId(name)).toBe("wif:mainnet:stored-id");
  expect(await getNamedWalletId(name, "bitcoincash")).toBe(
    "wif:mainnet:stored-id",
  );
  await expect(getNamedWalletId(name, "bchtest")).resolves.toBeUndefined();
  await expect(getNamedWalletId(`${name}-missing`)).resolves.toBeUndefined();
});

test("a named walletId may name only the database of its network", async () => {
  BaseWallet.StorageProvider = IndexedDBProvider;
  const name = `named-db-${Math.random()}`;
  const wallet = await RegTestWallet.named(name);
  const fromId = await RegTestWallet.fromId(`named:regtest:${name}:bchreg`);
  expect(fromId.cashaddr).toBe(wallet.cashaddr);
  await expect(
    RegTestWallet.fromId(`named:regtest:${name}:other-db`),
  ).rejects.toThrow("can only name the database bchreg");
  await expect(
    RegTestHDWallet.fromId(`named:regtest:${name}:other-db`),
  ).rejects.toThrow("can only name the database bchreg");
  await wallet.stop();
  await fromId.stop();
});

describe("namedWalletExists", () => {
  test("tells a stored name from a missing one, in the mainnet database by default", async () => {
    BaseWallet.StorageProvider = IndexedDBProvider;
    const name = `exists-${Math.random()}`;
    const testnetDb = new IndexedDBProvider("bchtest");
    await testnetDb.init();
    await testnetDb.addWallet(name, "wif:testnet:stored-id");
    await testnetDb.close();

    expect(await namedWalletExists(name, "bchtest")).toBe(true);
    expect(await namedWalletExists(name)).toBe(false);
    expect(await namedWalletExists(`${name}-missing`, "bchtest")).toBe(false);
    await expect(namedWalletExists("")).rejects.toThrow(
      "Named wallets must have a non-empty name",
    );
  });

  test("constructs no wallet", async () => {
    BaseWallet.StorageProvider = IndexedDBProvider;
    const name = `exists-${Math.random()}`;
    await Wallet.named(name);
    // every wallet takes its provider as it is constructed
    const construct = vi.spyOn(
      BaseWallet.prototype as unknown as { getNetworkProvider: () => unknown },
      "getNetworkProvider",
    );
    try {
      expect(await namedWalletExists(name)).toBe(true);
      expect(await namedWalletExists(`${name}-missing`)).toBe(false);
      expect(construct).not.toHaveBeenCalled();
    } finally {
      construct.mockRestore();
    }
  });

  test("closes the database when the check throws", async () => {
    const failure = new Error("store unreadable");
    const close = vi.fn();
    class FailingProvider extends IndexedDBProvider {
      async walletExists(): Promise<boolean> {
        throw failure;
      }
      async close() {
        close();
        return super.close();
      }
    }
    BaseWallet.StorageProvider = FailingProvider;
    try {
      await expect(namedWalletExists("alice")).rejects.toBe(failure);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      BaseWallet.StorageProvider = IndexedDBProvider;
    }
  });

  test("throws without a StorageProvider", async () => {
    BaseWallet.StorageProvider = undefined;
    try {
      await expect(namedWalletExists("alice")).rejects.toThrow(
        "No database was available or configured to store the named wallet.",
      );
    } finally {
      BaseWallet.StorageProvider = IndexedDBProvider;
    }
  });
});
