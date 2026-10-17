import { disconnectProviders, initProviders } from "#test/providers.js";
import { IndexedDbCache } from "../cache/IndexedDbCache.js";
import { Config } from "../config.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWatchWallet } from "./Watch.js";
import { RegTestWallet, RegTestWifWallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe("Wallet cache initialization", () => {
  test("Seed wallet should have walletCache with at least one entry", async () => {
    const wallet = await RegTestWallet.newRandom();
    expect(wallet.walletCache).toBeDefined();
    expect(wallet.walletCache!.get(wallet.cashaddr)).toBeDefined();
    expect(wallet.walletCache!.get(wallet.cashaddr)!.privateKey).toBeDefined();
  });

  test("Wif wallet should have walletCache with at least one entry", async () => {
    const wallet = await RegTestWifWallet.newRandom();
    expect(wallet.walletCache).toBeDefined();
    expect(wallet.walletCache!.get(wallet.cashaddr)).toBeDefined();
    expect(wallet.walletCache!.get(wallet.cashaddr)!.privateKey).toBeDefined();
  });

  test("Wif wallet from ID should have walletCache with at least one entry", async () => {
    const wallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    expect(wallet.walletCache).toBeDefined();
    expect(wallet.walletCache!.get(wallet.cashaddr)).toBeDefined();
    expect(wallet.walletCache!.get(wallet.cashaddr)!.privateKey).toBeDefined();
  });

  test("HD wallet should have walletCache with at least one entry", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    expect(wallet.walletCache).toBeDefined();
    const depositAddr = wallet.getDepositAddress();
    expect(wallet.walletCache!.get(depositAddr)).toBeDefined();
    expect(wallet.walletCache!.get(depositAddr)!.privateKey).toBeDefined();
    await wallet.stop();
  });

  test("Watch wallet should have walletCache without private key", async () => {
    const wallet = await RegTestWatchWallet.watchOnly(
      "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0",
    );
    expect(wallet.walletCache).toBeDefined();
    expect(wallet.walletCache!.get(wallet.cashaddr)).toBeDefined();
    expect(
      wallet.walletCache!.get(wallet.cashaddr)!.privateKey,
    ).toBeUndefined();
    await wallet.stop();
  });
});

describe("single-address wallet cache", () => {
  test("is never written to the cache storage", async () => {
    const prevIndexedDb = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    const storage = new IndexedDbCache("WalletCache");
    await storage.init();
    const before = await storage.keys();
    // a funded wallet, whose status, utxos and history the cache gets
    const funded = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const wallets = [
      funded,
      await RegTestWallet.newRandom(),
      await RegTestWatchWallet.watchOnly(funded.cashaddr),
    ];
    try {
      for (const wallet of wallets) {
        await wallet.getUtxos();
        await wallet.walletCache.persist(true);
      }
      expect(funded.walletCache.get(funded.cashaddr)!.utxos.length).toBe(
        (await funded.getUtxos()).length,
      );
      expect(funded.walletCache.get(funded.cashaddr)!.status).not.toBeNull();
      expect(await storage.keys()).toEqual(before);
    } finally {
      await Promise.all(wallets.map((wallet) => wallet.stop()));
      await storage.close();
      Config.UseIndexedDBCache = prevIndexedDb;
    }
  });
});
