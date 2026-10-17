import { randomUtxo } from "@paryonusd/mem-cash";
import { Network } from "../interface.js";
import {
  createProvider,
  removeGlobalProvider,
  setGlobalProvider,
} from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

// Two mock chains, so a wallet still listening on the old one would see its coins there
const miner = "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0";
let oldProvider: MockNetworkProvider;
let newProvider: MockNetworkProvider;

beforeEach(async () => {
  oldProvider = new MockNetworkProvider();
  newProvider = new MockNetworkProvider();
  await oldProvider.ready();
  await newProvider.ready();
  setGlobalProvider(Network.REGTEST, oldProvider);
});
afterEach(() => {
  removeGlobalProvider(Network.REGTEST);
});

async function fund(
  provider: MockNetworkProvider,
  address: string,
  satoshis: bigint,
) {
  await provider.addUtxo(address, {
    ...randomUtxo({ vout: 0, satoshis }),
    height: 100,
  });
}

describe("setProvider", () => {
  test("moves a single-address wallet's watches to the new provider", async () => {
    const wallet = await RegTestWallet.newRandom();
    const balances: bigint[] = [];
    await wallet.watchBalance((balance) => balances.push(balance));
    const headers: number[] = [];
    await wallet.watchBlocks((header) => headers.push(header.height));
    const before = oldProvider.subscriptions;

    await wallet.setProvider(newProvider);
    expect(wallet.provider).toBe(newProvider);
    expect(oldProvider.subscriptions).toBe(before - 2);

    await fund(oldProvider, wallet.cashaddr, 5_000n);
    await oldProvider.mine(miner, 2);
    await fund(newProvider, wallet.cashaddr, 10_000n);
    await newProvider.mine(miner, 1);
    await delay(200);

    expect(await wallet.getBalance()).toBe(10_000n);
    expect(balances.at(-1)).toBe(10_000n);
    expect(balances).not.toContain(5_000n);
    expect(headers).toEqual([201]);

    await wallet.stop();
    expect(newProvider.subscriptions).toBe(0);
  });

  test("moves an HD wallet's address discovery to the new provider", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const subscribed = oldProvider.subscriptions;
    expect(subscribed).toBeGreaterThanOrEqual(40);

    await wallet.setProvider(newProvider);
    expect(oldProvider.subscriptions).toBe(0);
    expect(newProvider.subscriptions).toBe(subscribed);

    const first = wallet.getDepositAddress();
    await fund(oldProvider, wallet.getDepositAddress(), 5_000n);
    await fund(newProvider, first, 10_000n);
    await wallet.waitForUpdate({ depositIndex: 1, timeout: 1000 });

    // discovery ran on the new chain: index 0 counts as used, and the gap is watched there
    expect(wallet.getDepositAddress()).not.toBe(first);
    expect(await wallet.getBalance()).toBe(10_000n);
    expect(newProvider.subscriptions).toBe(subscribed + 1);
    expect(oldProvider.subscriptions).toBe(0);

    await wallet.stop();
    expect(newProvider.subscriptions).toBe(0);
  });

  test("does not deliver the same tip again after a move", async () => {
    const wallet = await RegTestWallet.newRandom();
    const heights: number[] = [];
    await wallet.watchBlocks((header) => heights.push(header.height), false);
    expect(heights).toEqual([200]);

    await wallet.setProvider(newProvider);
    await delay(100);
    expect(heights).toEqual([200]);

    await newProvider.mine(miner, 1);
    await delay(100);
    expect(heights).toEqual([200, 201]);
    await wallet.stop();
  });

  test("stays on the old provider when the new one cannot connect", async () => {
    const wallet = await RegTestWallet.newRandom();
    const balances: bigint[] = [];
    await wallet.watchBalance((balance) => balances.push(balance));
    const before = oldProvider.subscriptions;

    const dead = await createProvider(Network.REGTEST, "ws://127.0.0.1:1", {
      connectTimeout: 300,
    });
    await expect(wallet.setProvider(dead)).rejects.toThrow();
    expect(wallet.provider).toBe(oldProvider);
    expect(oldProvider.subscriptions).toBe(before);
    // a retry tries again rather than taking the dead provider as already switched to
    await expect(wallet.setProvider(dead)).rejects.toThrow();

    await fund(oldProvider, wallet.cashaddr, 5_000n);
    await delay(200);
    expect(balances.at(-1)).toBe(5_000n);

    await wallet.setProvider(newProvider);
    expect(oldProvider.subscriptions).toBe(before - 1);
    expect(newProvider.subscriptions).toBe(1);
    await wallet.stop();
  });

  test("moves an HD wallet back when a subscription fails on the new provider", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const subscribed = oldProvider.subscriptions;

    let calls = 0;
    const flaky = new MockNetworkProvider();
    await flaky.ready();
    const subscribeToAddress = flaky.subscribeToAddress.bind(flaky);
    flaky.subscribeToAddress = async (...args) => {
      if (++calls === 5) throw new Error("subscription refused");
      return subscribeToAddress(...args);
    };
    await expect(wallet.setProvider(flaky)).rejects.toThrow(
      "subscription refused",
    );
    expect(wallet.provider).toBe(oldProvider);
    expect(oldProvider.subscriptions).toBe(subscribed);
    expect(flaky.subscriptions).toBe(0);

    await wallet.setProvider(newProvider);
    expect(oldProvider.subscriptions).toBe(0);
    expect(newProvider.subscriptions).toBe(subscribed);
    await wallet.stop();
  });

  test("refuses a provider of another network", async () => {
    const wallet = await RegTestWallet.newRandom();
    const mainnet = await createProvider(Network.MAINNET, "wss://127.0.0.1:1");
    await expect(wallet.setProvider(mainnet)).rejects.toThrow(
      "a mainnet provider cannot serve a regtest wallet",
    );
    expect(wallet.provider).toBe(oldProvider);
    await wallet.stop();
  });
});

describe("waitForTransaction", () => {
  test("ends its subscription for a transaction already known", async () => {
    const wallet = await RegTestWallet.newRandom();
    await fund(oldProvider, wallet.cashaddr, 10_000n);
    const { txId } = await wallet.send([
      { cashaddr: wallet.cashaddr, value: 1_000n },
    ]);
    const before = oldProvider.subscriptions;

    await wallet.waitForTransaction({ txHash: txId! });
    expect(oldProvider.subscriptions).toBe(before);

    // only the wallet's own address watch follows it to another provider
    await wallet.setProvider(newProvider);
    expect(newProvider.subscriptions).toBe(1);
    await wallet.stop();
  });
});

describe("stop", () => {
  test("ends a watch that was still subscribing when it ran", async () => {
    const wallet = await RegTestWallet.newRandom();
    const headers: number[] = [];

    const watching = wallet.watchBlocks((header) =>
      headers.push(header.height),
    );
    await wallet.stop();
    const cancel = await watching;
    expect(oldProvider.subscriptions).toBe(0);

    await oldProvider.mine(miner, 1);
    await delay(200);
    expect(headers).toEqual([]);
    await cancel();
  });
});
