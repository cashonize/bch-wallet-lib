import { Network } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

// A subscription that cannot be made settles what waits on it instead of leaving it pending
// (an async promise executor used to swallow the rejection, the hang of mainnet-js#256)
let provider: MockNetworkProvider;
let refuse: { address: boolean; transaction: boolean; headers: boolean };

beforeEach(async () => {
  provider = new MockNetworkProvider();
  await provider.ready();
  refuse = { address: false, transaction: false, headers: false };
  const subscribeToAddress = provider.subscribeToAddress.bind(provider);
  provider.subscribeToAddress = async (...args) => {
    if (refuse.address) throw new Error("subscription refused");
    return subscribeToAddress(...args);
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
afterEach(() => {
  removeGlobalProvider(Network.REGTEST);
});

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

  test("settles an HD wallet's address discovery", async () => {
    refuse.address = true;
    const wallet = await RegTestHDWallet.newRandom();
    expect(await wallet.getUtxos()).toEqual([]);
    await wallet.stop();
  }, 5000);

  test("rejects an HD wallet's scanMoreAddresses, and later reads go on", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    refuse.address = true;
    // beyond the addresses already watched, so the scan subscribes new ones
    await expect(wallet.scanMoreAddresses(40)).rejects.toThrow(
      "subscription refused",
    );
    expect(await wallet.getBalance()).toBe(0n);
    await wallet.stop();
  }, 5000);
});
