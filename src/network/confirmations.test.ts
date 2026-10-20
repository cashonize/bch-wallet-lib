import type { CacheProvider } from "../cache/interface.js";
import { Config } from "../config.js";
import { mine } from "#test/mine.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { delay } from "../util/delay.js";
import { RegTestWallet } from "../wallet/Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe("Dynamic confirmations via fetchHeight", () => {
  test("confirmations is present on verbose server response", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const utxo = (await alice.getUtxos())[0];
    const transaction = await alice.provider.getRawTransactionObject(utxo.txid);
    expect(transaction.confirmations).toBeGreaterThan(0);
  });

  test("fetchHeight is not exposed in returned transaction", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const utxo = (await alice.getUtxos())[0];
    const transaction = await alice.provider.getRawTransactionObject(utxo.txid);
    expect((transaction as any).fetchHeight).toBeUndefined();
  });

  test("cached transaction has up-to-date confirmations", async () => {
    const indexedDbCacheValue = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    try {
      const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
      // the provider connected before the cache was turned on, so its cache is not open yet
      await (
        alice.provider as unknown as { cache: CacheProvider }
      ).cache.init();
      const utxo = (await alice.getUtxos())[0];

      const tx1 = await alice.provider.getRawTransactionObject(utxo.txid);
      const confirmations1 = tx1.confirmations;

      await mine({ cashaddr: alice.cashaddr!, blocks: 1 });
      await delay(1000);

      const tx2 = await alice.provider.getRawTransactionObject(utxo.txid);
      expect(tx2.confirmations).toBe(confirmations1 + 1);
      expect((tx2 as any).fetchHeight).toBeUndefined();
    } finally {
      Config.UseIndexedDBCache = indexedDbCacheValue;
    }
  });

  test("a transaction cached unconfirmed reports its confirmations once mined", async () => {
    const indexedDbCacheValue = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    try {
      const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
      await (
        alice.provider as unknown as { cache: CacheProvider }
      ).cache.init();
      const bob = await RegTestWallet.newRandom();
      const { txId } = await alice.send({
        cashaddr: bob.cashaddr!,
        value: 1_000n,
      });

      const unconfirmed = await alice.provider.getRawTransactionObject(txId!);
      expect(unconfirmed.confirmations).toBe(0);

      await mine({ cashaddr: alice.cashaddr!, blocks: 1 });
      await delay(1000);

      const mined = await alice.provider.getRawTransactionObject(txId!);
      expect(mined.confirmations).toBe(1);
      expect(mined.blockhash).toBeDefined();
      await bob.stop();
    } finally {
      Config.UseIndexedDBCache = indexedDbCacheValue;
    }
  });
});
