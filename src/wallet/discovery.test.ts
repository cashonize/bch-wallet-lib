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

// A funded wallet sending to another, with the provider's address subscriptions held from the
// moment hold() is called until the returned release runs
async function sendSetup() {
  const wallet = await RegTestHDWallet.newRandom();
  await wallet["watchPromise"];
  await fund(wallet.getDepositAddress(0), 100_000n);
  await vi.waitFor(async () => {
    expect(await wallet.getBalance()).toBe(100_000n);
  });
  const receiver = await RegTestHDWallet.newRandom();
  await receiver.stop();

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const subscribe = provider.subscribeToAddress.bind(provider);
  const hold = () => {
    provider.subscribeToAddress = async (...args) => {
      await held;
      return subscribe(...args);
    };
  };
  // without the fix under test the send waits out its 10 s ceiling on the coin view
  const sendWithin3s = async () => {
    try {
      const started = Date.now();
      await wallet.send({
        cashaddr: receiver.getDepositAddress(0),
        value: 10_000n,
      });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      release();
      await wallet.stop();
    }
  };
  return { wallet, hold, sendWithin3s };
}

// coinsNow: a send's coin wait reads the coins without waiting for the discovery its new change
// address starts, which adds only unused addresses past the gap
test("returns from an HD send while the discovery its change address started is held", async () => {
  const { hold, sendWithin3s } = await sendSetup();
  hold();
  await sendWithin3s();
}, 15000);

// watchStatus `immediate`: a discovery started before the coin wait registers its status watch is
// not waited for either, the send's coins sitting on addresses already watched
test("returns from an HD send while a discovery started before its coin wait is held", async () => {
  const { wallet, hold, sendWithin3s } = await sendSetup();
  // at broadcast: hold the subscriptions, then start a discovery with a wider window than the one
  // watched, whose new addresses therefore stay held
  const broadcast = provider.sendRawTransaction.bind(provider);
  provider.sendRawTransaction = async (...args) => {
    hold();
    void wallet["startDiscovery"](40);
    return broadcast(...args);
  };
  await sendWithin3s();
}, 15000);
