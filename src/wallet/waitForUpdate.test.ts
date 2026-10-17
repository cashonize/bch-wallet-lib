import { Network } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

// waitForUpdate gives up after its timeout without a status change, and the timeout only starts
// once the wallet's status watch is in place
let provider: MockNetworkProvider;
let subscribeDelay: number;

beforeEach(async () => {
  provider = new MockNetworkProvider();
  await provider.connect();
  subscribeDelay = 0;
  const subscribeToAddress = provider.subscribeToAddress.bind(provider);
  provider.subscribeToAddress = async (...args) => {
    await delay(subscribeDelay);
    return subscribeToAddress(...args);
  };
  setGlobalProvider(Network.REGTEST, provider);
});
afterEach(() => {
  removeGlobalProvider(Network.REGTEST);
});

describe("waitForUpdate", () => {
  test("a single-address wallet's resolves after its timeout without a status change", async () => {
    const wallet = await RegTestWallet.newRandom();
    await wallet.watchPromise;
    const start = Date.now();
    await wallet.waitForUpdate({ timeout: 50 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    await wallet.stop();
  }, 5000);

  test("a single-address wallet's resolves when its first subscription outlasts the timeout", async () => {
    subscribeDelay = 200;
    const wallet = await RegTestWallet.newRandom();
    const start = Date.now();
    // the timer used to win before the watch was in place and call an undefined cancel function
    await wallet.waitForUpdate({ timeout: 10 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    await wallet.stop();
  }, 5000);

  test("an HD wallet's resolves after its timeout when the target index is not reached", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const start = Date.now();
    await wallet.waitForUpdate({ depositIndex: 1, timeout: 50 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    expect(wallet.getDepositAddress()).toBe(wallet.getDepositAddress(0));
    await wallet.stop();
  }, 5000);
});
