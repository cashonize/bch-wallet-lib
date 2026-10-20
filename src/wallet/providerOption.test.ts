import { randomUtxo } from "@paryonusd/mem-cash";
import IndexedDBProvider from "../indexeddb/IndexedDBProvider.js";
import { Network } from "../interface.js";
import {
  createProvider,
  getGlobalProvider,
  removeGlobalProvider,
  setGlobalProvider,
} from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { BaseWallet } from "./Base.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const WIF = "cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6";

// The global provider, every way it could be reached spied on, and the one the wallets are made with
let globalProvider: MockNetworkProvider;
let chosen: MockNetworkProvider;
let globalUse: ReturnType<typeof vi.spyOn>[];

beforeEach(async () => {
  globalProvider = new MockNetworkProvider();
  chosen = new MockNetworkProvider();
  // a coin added while the mock chain is still setting up can miss its status notification
  await chosen.connect();
  setGlobalProvider(Network.REGTEST, globalProvider);
  // performRequest and subscribeRequest are protected; every request goes through one of them
  const spied = globalProvider as unknown as Record<string, () => unknown>;
  globalUse = [
    vi.spyOn(spied, "connect"),
    vi.spyOn(spied, "performRequest"),
    vi.spyOn(spied, "subscribeRequest"),
  ];
});
afterEach(() => {
  removeGlobalProvider(Network.REGTEST);
  vi.restoreAllMocks();
});

function expectGlobalUnused() {
  for (const spy of globalUse) expect(spy).not.toHaveBeenCalled();
}

async function fund(address: string, satoshis: bigint) {
  await chosen.addUtxo(address, {
    ...randomUtxo({ vout: 0, satoshis }),
    height: 100,
  });
}

describe("the provider factory option", () => {
  test("a wallet made without it uses the global provider", async () => {
    const wallet = await RegTestWallet.newRandom();
    expect(wallet.provider).toBe(globalProvider);
    await wallet.getBalance();
    expect(globalUse[2]).toHaveBeenCalled();
    await wallet.stop();
  });

  test("a single-address wallet reads, watches and sends on it alone", async () => {
    const wallet = await RegTestWallet.fromId(`wif:regtest:${WIF}`, {
      provider: chosen,
    });
    expect(wallet.provider).toBe(chosen);
    await fund(wallet.cashaddr, 10_000n);
    await delay(100);

    expect(await wallet.getBalance()).toBe(10_000n);
    const heights: number[] = [];
    await wallet.watchBlocks((header) => heights.push(header.height), false);
    expect(heights).toEqual([200]);
    const sent = await wallet.send([
      { cashaddr: wallet.cashaddr, value: 1_000n },
    ]);
    expect((await chosen.getRawTransactionObject(sent.txId)).txid).toBe(
      sent.txId,
    );
    expect(await wallet.getHistory()).toHaveLength(2);

    await wallet.stop();
    // the provider's own header subscription, for the block height of the send, is left
    await chosen.disconnect();
    expect(chosen.subscriptions).toBe(0);
    expectGlobalUnused();
  });

  test("an HD wallet's address discovery runs on it alone", async () => {
    const wallet = await RegTestHDWallet.fromId(`hd:regtest:${MNEMONIC}`, {
      provider: chosen,
    });
    await wallet["watchPromise"];
    expect(chosen.subscriptions).toBeGreaterThanOrEqual(40);

    await fund(wallet.getDepositAddress(), 10_000n);
    await wallet["waitForUpdate"]({ indices: { 0: 1 }, timeout: 1000 });
    expect(await wallet.getBalance()).toBe(10_000n);

    await wallet.stop();
    expect(chosen.subscriptions).toBe(0);
    expectGlobalUnused();
  });

  test("every factory takes it", async () => {
    const options = { provider: chosen };
    const wallets: BaseWallet[] = [
      await RegTestWallet.newRandom("", options),
      await RegTestWallet.fromWIF(WIF, options),
      await RegTestWallet.fromId(`seed:regtest:${MNEMONIC}`, options),
      await RegTestWallet.fromId(
        "watch:regtest:bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0",
        options,
      ),
      await RegTestHDWallet.newRandom("", options),
    ];

    const prevStorage = BaseWallet.StorageProvider;
    BaseWallet.StorageProvider = IndexedDBProvider;
    try {
      const name = `provider-option-${Math.random()}`;
      wallets.push(
        await RegTestWallet.named(name, options),
        // the stored one again
        await RegTestWallet.named(name, options),
        await RegTestWallet.newRandom(`${name}-random`, options),
        await RegTestWallet.fromId(`named:regtest:${name}`, options),
        await RegTestWallet.replaceNamed(
          `${name}-replaced`,
          `wif:regtest:${WIF}`,
          options,
        ),
        await RegTestHDWallet.named(`${name}-hd`, options),
        await RegTestHDWallet.newRandom(`${name}-hd-random`, options),
        await RegTestHDWallet.replaceNamed(
          `${name}-hd-replaced`,
          `hd:regtest:${MNEMONIC}`,
          options,
        ),
      );
    } finally {
      BaseWallet.StorageProvider = prevStorage;
    }

    for (const wallet of wallets) {
      expect(wallet.provider).toBe(chosen);
      await wallet.getBalance();
    }
    for (const wallet of wallets) await wallet.stop();
    expect(chosen.subscriptions).toBe(0);
    expectGlobalUnused();
  });

  test("no global provider is created for a wallet made with it", async () => {
    removeGlobalProvider(Network.REGTEST);
    const wallet = await RegTestHDWallet.newRandom("", { provider: chosen });
    await wallet.getBalance();
    expect(getGlobalProvider(Network.REGTEST)).toBeUndefined();
    await wallet.stop();
  });

  test("setProvider on a wallet made with new creates no global provider", async () => {
    removeGlobalProvider(Network.REGTEST);
    const wallet = new RegTestWallet();
    await wallet.setProvider(chosen);
    expect(wallet.provider).toBe(chosen);
    expect(getGlobalProvider(Network.REGTEST)).toBeUndefined();
  });

  test("refuses a provider of another network", async () => {
    const mainnet = await createProvider(Network.MAINNET, "wss://127.0.0.1:1");
    await expect(
      RegTestWallet.newRandom("", { provider: mainnet }),
    ).rejects.toThrow("a mainnet provider cannot serve a regtest wallet");
    await expect(
      RegTestHDWallet.fromId(`hd:regtest:${MNEMONIC}`, { provider: mainnet }),
    ).rejects.toThrow("a mainnet provider cannot serve a regtest wallet");
    expectGlobalUnused();
  });

  test("setProvider moves a wallet made with it", async () => {
    const wallet = await RegTestWallet.newRandom("", { provider: chosen });
    await wallet.getBalance();
    const other = new MockNetworkProvider();
    await wallet.setProvider(other);
    expect(wallet.provider).toBe(other);
    expect(chosen.subscriptions).toBe(0);
    expect(other.subscriptions).toBe(1);
    await wallet.stop();
    expectGlobalUnused();
  });
});
