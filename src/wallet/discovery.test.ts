import { randomUtxo } from "@paryonusd/mem-cash";
import { Config } from "../config.js";
import { Network } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { RegTestHDWallet } from "./HDWallet.js";

// How an HD wallet's address discovery starts and how much it sends at once
let provider: MockNetworkProvider;

beforeEach(async () => {
  provider = new MockNetworkProvider();
  await provider.connect();
  setGlobalProvider(Network.REGTEST, provider);
});
afterEach(() => {
  removeGlobalProvider(Network.REGTEST);
});

async function fund(address: string, satoshis: bigint) {
  await provider.addUtxo(address, {
    ...randomUtxo({ vout: 0, satoshis }),
    height: 100,
  });
}

// Wraps a provider's address subscriptions, returning the most that were in flight at once since
// the last reset
function countInFlight(target: MockNetworkProvider) {
  let inFlight = 0;
  let most = 0;
  const subscribe = target.subscribeToAddress.bind(target);
  target.subscribeToAddress = async (...args) => {
    inFlight++;
    most = Math.max(most, inFlight);
    try {
      await delay(1);
      return await subscribe(...args);
    } finally {
      inFlight--;
    }
  };
  return {
    most: () => most,
    reset: () => {
      most = 0;
    },
  };
}

// A named wallet's stored id carries no indices, so discovery started at 0 on every open and moved
// its window about 20 addresses per round trip
test("starts discovery where the cache saw the wallet used", async () => {
  const cacheSetting = Config.UseIndexedDBCache;
  Config.UseIndexedDBCache = true;
  try {
    const seedWallet = await RegTestHDWallet.newRandom();
    await seedWallet["watchPromise"];
    await seedWallet.stop();
    for (const index of [15, 30, 45]) {
      await fund(seedWallet.getDepositAddress(index), 1_000n);
    }
    const id = `hd:regtest:${seedWallet.mnemonic!}:${seedWallet.derivation}`;
    const first = await RegTestHDWallet.fromId(id);
    expect(await first.getBalance()).toBe(3_000n);
    await first.stop();

    const reopened = await RegTestHDWallet.fromId(id);
    // before its discovery has run a round
    expect(reopened.indices.get(0)).toBe(46);
    expect(await reopened.getBalance()).toBe(3_000n);
    await reopened.stop();
  } finally {
    Config.UseIndexedDBCache = cacheSetting;
  }
}, 10000);

test("subscribes a large range a bounded number at a time", async () => {
  const inFlight = countInFlight(provider);
  const seedWallet = await RegTestHDWallet.newRandom();
  await seedWallet["watchPromise"];
  await seedWallet.stop();
  inFlight.reset();

  // indices of 100 on both branches: a first round of 120 addresses each
  const wallet = await RegTestHDWallet.fromId(
    `hd:regtest:${seedWallet.mnemonic!}:${seedWallet.derivation}:100:100`,
  );
  await wallet["watchPromise"];
  expect(provider.subscriptions).toBe(240);
  expect(inFlight.most()).toBeLessThanOrEqual(50);
  await wallet.stop();
}, 10000);

// an address still waiting for a slot when the wallet stops never subscribes, and must not leave
// discovery and the reads behind it pending
test("settles reads of a wallet stopped while discovery waits for slots", async () => {
  const seedWallet = await RegTestHDWallet.newRandom();
  await seedWallet["watchPromise"];
  await seedWallet.stop();
  const subscribe = provider.subscribeToAddress.bind(provider);
  provider.subscribeToAddress = async (...args) => {
    await delay(5);
    return subscribe(...args);
  };

  const wallet = await RegTestHDWallet.fromId(
    `hd:regtest:${seedWallet.mnemonic!}:${seedWallet.derivation}:100:100`,
  );
  await delay(1);
  await wallet.stop();
  const read = wallet.getBalance().then(
    () => "settled",
    () => "settled",
  );
  expect(await Promise.race([read, delay(2000).then(() => "pending")])).toBe(
    "settled",
  );
}, 10000);

test("moves a large range to a new provider a bounded number at a time", async () => {
  const seedWallet = await RegTestHDWallet.newRandom();
  await seedWallet["watchPromise"];
  await seedWallet.stop();
  const wallet = await RegTestHDWallet.fromId(
    `hd:regtest:${seedWallet.mnemonic!}:${seedWallet.derivation}:100:100`,
  );
  await wallet["watchPromise"];

  const newProvider = new MockNetworkProvider();
  await newProvider.connect();
  const inFlight = countInFlight(newProvider);
  await wallet.setProvider(newProvider);
  expect(newProvider.subscriptions).toBe(240);
  expect(inFlight.most()).toBeLessThanOrEqual(50);
  await wallet.stop();
}, 10000);
