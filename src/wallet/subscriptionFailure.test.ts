import { randomUtxo } from "@paryonusd/mem-cash";
import { Network } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

// A subscription that cannot be made settles what waits on it instead of leaving it pending
// (an async promise executor used to swallow the rejection, the hang of mainnet-js#256)
let provider: MockNetworkProvider;
let refuse: {
  address: boolean;
  addresses: Set<string>;
  transaction: boolean;
  headers: boolean;
  fetch: boolean;
};
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(async () => {
  provider = new MockNetworkProvider();
  await provider.ready();
  refuse = {
    address: false,
    addresses: new Set(),
    transaction: false,
    headers: false,
    fetch: false,
  };
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  const subscribeToAddress = provider.subscribeToAddress.bind(provider);
  provider.subscribeToAddress = async (...args) => {
    if (refuse.address || refuse.addresses.has(args[0])) {
      throw new Error("subscription refused");
    }
    return subscribeToAddress(...args);
  };
  const getUtxos = provider.getUtxos.bind(provider);
  provider.getUtxos = async (...args) => {
    if (refuse.fetch) throw new Error("connection lost");
    return getUtxos(...args);
  };
  const subscribeToTransaction = provider.subscribeToTransaction.bind(provider);
  provider.subscribeToTransaction = async (...args) => {
    if (refuse.transaction) throw new Error("subscription refused");
    return subscribeToTransaction(...args);
  };
  const subscribeToHeaders = provider.subscribeToHeaders.bind(provider);
  provider.subscribeToHeaders = async (...args) => {
    if (refuse.headers) throw new Error("subscription refused");
    return subscribeToHeaders(...args);
  };
  setGlobalProvider(Network.REGTEST, provider);
});
afterEach(async () => {
  removeGlobalProvider(Network.REGTEST);
  // unhandled rejections are reported once the microtasks have run
  await delay(20);
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

async function fund(address: string, satoshis: bigint) {
  await provider.addUtxo(address, {
    ...randomUtxo({ vout: 0, satoshis }),
    height: 100,
  });
}

const txHash = "00".repeat(32);

describe("a subscription that cannot be made", () => {
  test("rejects waitForTransaction for a txHash", async () => {
    const wallet = await RegTestWallet.newRandom();
    refuse.transaction = true;
    await expect(wallet.waitForTransaction({ txHash })).rejects.toThrow(
      "subscription refused",
    );
    await wallet.stop();
  }, 5000);

  test("rejects waitForBlock", async () => {
    refuse.headers = true;
    await expect(provider.waitForBlock()).rejects.toThrow(
      "subscription refused",
    );
  }, 5000);

  test("rejects sendRawTransaction awaiting propagation", async () => {
    refuse.transaction = true;
    await expect(provider.sendRawTransaction("00", true)).rejects.toThrow(
      "subscription refused",
    );
  }, 5000);

  test("settles a single-address wallet's first status watch", async () => {
    refuse.address = true;
    const wallet = await RegTestWallet.newRandom();
    expect(await wallet.getBalance()).toBe(0n);
    await wallet.stop();
  }, 5000);

  test("rejects an HD wallet's reads, and the next read runs its discovery again", async () => {
    refuse.address = true;
    const wallet = await RegTestHDWallet.newRandom();
    await expect(wallet.getUtxos()).rejects.toThrow("subscription refused");
    await expect(wallet.getBalance()).rejects.toThrow("subscription refused");
    expect(provider.subscriptions).toBe(0);

    refuse.address = false;
    expect(await wallet.getUtxos()).toEqual([]);
    expect(provider.subscriptions).toBe(40);
    // the addresses are watched again
    await fund(wallet.getDepositAddress(0), 5_000n);
    await wallet.waitForUpdate({ depositIndex: 1 });
    expect(await wallet.getBalance()).toBe(5_000n);
    await wallet.stop();
  }, 5000);

  test("does not run a failed HD discovery again once the wallet is stopped", async () => {
    refuse.address = true;
    const wallet = await RegTestHDWallet.newRandom();
    await expect(wallet.getUtxos()).rejects.toThrow("subscription refused");
    await wallet.stop();

    refuse.address = false;
    await expect(wallet.getUtxos()).rejects.toThrow("subscription refused");
    expect(provider.subscriptions).toBe(0);
  }, 5000);

  test("subscribes again an HD address that failed between watched ones", async () => {
    const seedWallet = await RegTestHDWallet.newRandom();
    const address = seedWallet.getDepositAddress(5);
    await seedWallet.watchPromise;
    await seedWallet.stop();
    await fund(address, 5_000n);

    refuse.addresses.add(address);
    const wallet = await RegTestHDWallet.fromSeed(
      seedWallet.mnemonic!,
      seedWallet.derivation,
    );
    await expect(wallet.getBalance()).rejects.toThrow("subscription refused");
    expect(provider.subscriptions).toBe(39);

    refuse.addresses.clear();
    expect(await wallet.getBalance()).toBe(5_000n);
    expect(wallet.indices.get(0)).toBe(6);
    // the gap beyond the found address is watched too
    expect(provider.subscriptions).toBe(46);
    await wallet.stop();
  }, 5000);

  test("rejects an HD wallet's scanMoreAddresses, and a later scan subscribes what it missed", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    refuse.address = true;
    // beyond the addresses already watched, so the scan subscribes new ones
    await expect(wallet.scanMoreAddresses(40)).rejects.toThrow(
      "subscription refused",
    );
    // reads need only the gap that is watched
    expect(await wallet.getBalance()).toBe(0n);
    refuse.address = false;
    await wallet.scanMoreAddresses(40);
    expect(provider.subscriptions).toBe(80);
    await wallet.stop();
  }, 5000);

  test("settles a watcher's read while a gap extension has failed", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const balances: bigint[] = [];
    await wallet.watchBalance((balance) => balances.push(balance));

    // the used address moves the gap, and its extension cannot subscribe
    refuse.address = true;
    await fund(wallet.getDepositAddress(15), 1_000n);
    await delay(300);
    expect(balances).toEqual([]);
    await expect(wallet.getBalance()).rejects.toThrow("subscription refused");

    refuse.address = false;
    expect(await wallet.getBalance()).toBe(1_000n);
    await wallet.stop();
  }, 5000);
});

describe("a fetch that fails during HD address discovery", () => {
  test("rejects the reads, and the next read fetches again", async () => {
    const seedWallet = await RegTestHDWallet.newRandom();
    await seedWallet.watchPromise;
    await seedWallet.stop();
    await fund(seedWallet.getDepositAddress(0), 5_000n);

    refuse.fetch = true;
    const wallet = await RegTestHDWallet.fromSeed(
      seedWallet.mnemonic!,
      seedWallet.derivation,
    );
    await expect(wallet.getUtxos()).rejects.toThrow("connection lost");

    refuse.fetch = false;
    const utxos = await wallet.getUtxos();
    expect(utxos.map((utxo) => utxo.satoshis)).toEqual([5_000n]);
    expect(wallet.indices.get(0)).toBe(1);
    await wallet.stop();
  }, 5000);

  test("after discovery, leaves the address for its next notification to fetch", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const address = wallet.getDepositAddress(0);

    refuse.fetch = true;
    await fund(address, 5_000n);
    await delay(100);
    expect(await wallet.getBalance()).toBe(0n);

    refuse.fetch = false;
    await fund(address, 7_000n);
    await wallet.waitForUpdate({ depositIndex: 1 });
    expect(await wallet.getBalance()).toBe(12_000n);
    await wallet.stop();
  }, 5000);
});
