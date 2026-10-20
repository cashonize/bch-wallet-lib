import { randomUtxo } from "@paryonusd/mem-cash";
import { Network } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWatchWallet } from "./Watch.js";
import { RegTestWallet } from "./Wif.js";
import type { CancelFn } from "./interface.js";

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
  await provider.connect();
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
  // subscribeToHeaders is private; the test wraps it from outside
  const headers = provider as unknown as {
    subscribeToHeaders: (...args: unknown[]) => Promise<CancelFn>;
  };
  const subscribeToHeaders = headers.subscribeToHeaders.bind(provider);
  headers.subscribeToHeaders = async (...args) => {
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

async function newAddress() {
  const wallet = await RegTestWallet.newRandom();
  await wallet.stop();
  return wallet.cashaddr;
}

describe("a subscription that cannot be made", () => {
  test("rejects watchBlocks", async () => {
    const wallet = await RegTestWallet.newRandom();
    refuse.headers = true;
    await expect(wallet.watchBlocks(() => {})).rejects.toThrow(
      "subscription refused",
    );
    await wallet.stop();
  }, 5000);

  test("rejects sendRawTransaction awaiting propagation", async () => {
    refuse.transaction = true;
    await expect(provider.sendRawTransaction("00")).rejects.toThrow(
      "subscription refused",
    );
  }, 5000);

  test("a broadcast whose report never comes returns the txid of the transaction the chain took", async () => {
    const wallet = await RegTestWallet.newRandom();
    await fund(wallet.cashaddr, 10_000n);
    const { transaction, txId } = await wallet.send(
      { cashaddr: wallet.cashaddr, value: 5_000n },
      { broadcast: false },
    );
    await wallet.stop();
    // the subscription is made, and its notifications are dropped
    const subscribe = provider.subscribeToTransaction.bind(provider);
    provider.subscribeToTransaction = (txHash) => subscribe(txHash, () => {});

    expect(
      await provider.sendRawTransaction(transaction!, { statusTimeout: 50 }),
    ).toBe(txId);
    expect(await provider.getRawTransaction(txId)).toBe(transaction);
    expect(provider.subscriptions).toBe(0);
  }, 5000);

  test("rejects a single-address wallet's reads, and the next read subscribes again", async () => {
    refuse.address = true;
    const wallet = await RegTestWallet.newRandom();
    await expect(wallet.getBalance()).rejects.toThrow("subscription refused");
    await expect(wallet.getUtxos()).rejects.toThrow("subscription refused");
    await expect(wallet.getRawHistory()).rejects.toThrow(
      "subscription refused",
    );
    await expect(wallet.getHistory()).rejects.toThrow("subscription refused");
    await expect(wallet["watchStatus"](() => {})).rejects.toThrow(
      "subscription refused",
    );
    expect(provider.subscriptions).toBe(0);

    refuse.address = false;
    expect(await wallet.getBalance()).toBe(0n);
    expect(provider.subscriptions).toBe(1);
    // the address is watched again
    await fund(wallet.cashaddr, 5_000n);
    await delay(100);
    expect(await wallet.getBalance()).toBe(5_000n);
    await wallet.stop();
  }, 5000);

  test("rejects a watch-only wallet's reads, and the next read subscribes again", async () => {
    const address = await newAddress();
    await fund(address, 5_000n);
    refuse.address = true;
    const wallet = await new RegTestWatchWallet()["watchOnly"](address);
    await expect(wallet.getUtxos()).rejects.toThrow("subscription refused");

    refuse.address = false;
    const utxos = await wallet.getUtxos();
    expect(utxos.map((utxo) => utxo.satoshis)).toEqual([5_000n]);
    await wallet.stop();
  }, 5000);

  test("does not subscribe a single-address wallet again once it is stopped", async () => {
    refuse.address = true;
    const wallet = await RegTestWallet.newRandom();
    await expect(wallet.getBalance()).rejects.toThrow("subscription refused");
    await wallet.stop();

    refuse.address = false;
    await expect(wallet.getBalance()).rejects.toThrow("subscription refused");
    expect(provider.subscriptions).toBe(0);
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
    await wallet["waitForUpdate"]({ indices: { 0: 1 } });
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
    await seedWallet["watchPromise"];
    await seedWallet.stop();
    await fund(address, 5_000n);

    refuse.addresses.add(address);
    const wallet = await RegTestHDWallet.fromId(
      `hd:regtest:${seedWallet.mnemonic!}:${seedWallet.derivation}`,
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

  test("counts the gap only up to an address a failed scan left unwatched", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet["watchPromise"];
    refuse.address = true;
    // a discovery with a wider gap than the wallet's, as a used address far out would start
    await expect(wallet["startDiscovery"](40)).rejects.toThrow(
      "subscription refused",
    );
    refuse.address = false;
    expect(await wallet.getBalance()).toBe(0n);

    // the used address leaves the scan's unwatched addresses inside the gap
    await fund(wallet.getDepositAddress(19), 1_000n);
    await wallet["waitForUpdate"]({ indices: { 0: 20 } });
    // waits for the gap extension
    expect(await wallet.getBalance()).toBe(1_000n);
    await fund(wallet.getDepositAddress(20), 2_000n);
    await wallet["waitForUpdate"]({ indices: { 0: 21 } });
    expect(await wallet.getBalance()).toBe(3_000n);
    await wallet.stop();
  }, 5000);

  test("settles a watcher's read while a gap extension has failed", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet["watchPromise"];
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

describe("a single-address wallet's fetch that fails", () => {
  test("on the first status, rejects the reads, and the next read fetches again", async () => {
    const address = await newAddress();
    await fund(address, 5_000n);
    refuse.fetch = true;
    const wallet = await new RegTestWatchWallet()["watchOnly"](address);
    await expect(wallet.getBalance()).rejects.toThrow("connection lost");
    // the failed watch is ended, not left to be notified
    await delay(20);
    expect(provider.subscriptions).toBe(0);

    refuse.fetch = false;
    expect(await wallet.getBalance()).toBe(5_000n);
    expect(provider.subscriptions).toBe(1);
    await wallet.stop();
  }, 5000);

  test("later, leaves the old status for the next notification to fetch", async () => {
    const wallet = await RegTestWallet.newRandom();
    expect(await wallet.getBalance()).toBe(0n);
    const balances: bigint[] = [];
    await wallet.watchBalance((balance) => {
      balances.push(balance);
    });

    refuse.fetch = true;
    await fund(wallet.cashaddr, 5_000n);
    await delay(100);
    expect(await wallet.getBalance()).toBe(0n);
    expect(balances).toEqual([]);

    refuse.fetch = false;
    await fund(wallet.cashaddr, 7_000n);
    await delay(100);
    expect(await wallet.getBalance()).toBe(12_000n);
    expect(balances).toEqual([12_000n]);
    await wallet.stop();
  }, 5000);
});

describe("a fetch that fails during HD address discovery", () => {
  test("rejects the reads, and the next read fetches again", async () => {
    const seedWallet = await RegTestHDWallet.newRandom();
    await seedWallet["watchPromise"];
    await seedWallet.stop();
    await fund(seedWallet.getDepositAddress(0), 5_000n);

    refuse.fetch = true;
    const wallet = await RegTestHDWallet.fromId(
      `hd:regtest:${seedWallet.mnemonic!}:${seedWallet.derivation}`,
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
    await wallet["watchPromise"];
    const address = wallet.getDepositAddress(0);

    refuse.fetch = true;
    await fund(address, 5_000n);
    await delay(100);
    expect(await wallet.getBalance()).toBe(0n);

    refuse.fetch = false;
    await fund(address, 7_000n);
    await wallet["waitForUpdate"]({ indices: { 0: 1 } });
    expect(await wallet.getBalance()).toBe(12_000n);
    await wallet.stop();
  }, 5000);

  test("leaves an address unwatched when it fails while its first fetch is in flight", async () => {
    const seedWallet = await RegTestHDWallet.newRandom();
    await seedWallet["watchPromise"];
    await seedWallet.stop();
    await fund(seedWallet.getDepositAddress(0), 5_000n);

    // the subscriptions deliver their status here, then move to a provider that refuses them
    const subscribeToAddress = provider.subscribeToAddress.bind(provider);
    provider.subscribeToAddress = async (...args) => {
      const cancel = await subscribeToAddress(...args);
      await delay(100);
      return cancel;
    };
    // the first fetch is still in flight when the move fails, whichever provider it went to
    const getUtxos = provider.getUtxos.bind(provider);
    provider.getUtxos = async (...args) => {
      await delay(200);
      return getUtxos(...args);
    };
    const newProvider = new MockNetworkProvider();
    await newProvider.connect();
    let refuseNew = true;
    const subscribeNew = newProvider.subscribeToAddress.bind(newProvider);
    newProvider.subscribeToAddress = async (...args) => {
      if (refuseNew) throw new Error("subscription refused");
      return subscribeNew(...args);
    };
    const getUtxosNew = newProvider.getUtxos.bind(newProvider);
    newProvider.getUtxos = async (...args) => {
      await delay(200);
      return getUtxosNew(...args);
    };

    // what fromId does, minus the parsing: the moves below are timed against the discovery's start
    const wallet = await new RegTestHDWallet()["initialize"]({
      mnemonic: seedWallet.mnemonic,
      derivation: seedWallet.derivation,
    });
    await wallet.setProvider(newProvider);
    await expect(wallet.getBalance()).rejects.toThrow("subscription refused");
    // the fetch of the address's first status ends after it failed
    await delay(250);

    refuseNew = false;
    expect(await wallet.getBalance()).toBe(0n);
    expect(newProvider.subscriptions).toBe(40);
    // the address is watched on the new provider
    await newProvider.addUtxo(wallet.getDepositAddress(0), {
      ...randomUtxo({ vout: 0, satoshis: 3_000n }),
      height: 100,
    });
    await wallet["waitForUpdate"]({ indices: { 0: 1 }, timeout: 1000 });
    expect(await wallet.getBalance()).toBe(3_000n);
    await wallet.stop();
  }, 5000);
});
