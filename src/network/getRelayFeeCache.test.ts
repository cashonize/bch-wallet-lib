import { Config } from "../config.js";
import { getRelayFeeCache } from "./getRelayFeeCache.js";
import { MockNetworkProvider } from "./MockNetworkProvider.js";

// A mock chain whose server reports the given blockchain.relayfee, in BCH per kB
function providerWithRelayFee(relayFeePerKbInCoins: number) {
  const provider = new MockNetworkProvider();
  provider.getRelayFee = async () => relayFeePerKbInCoins;
  return provider;
}

afterEach(() => {
  Config.RelayFeePerByte = undefined;
});

test("uses the server's relay fee in satoshis per byte", async () => {
  expect(await getRelayFeeCache(providerWithRelayFee(0.00002))).toBe(2);
});

test("caches the relay fee per provider", async () => {
  const first = providerWithRelayFee(0.00002);
  const second = providerWithRelayFee(0.00003);
  expect(await getRelayFeeCache(first)).toBe(2);
  expect(await getRelayFeeCache(second)).toBe(3);
  first.getRelayFee = async () => 0.00004;
  expect(await getRelayFeeCache(first)).toBe(2);
});

test("Config.RelayFeePerByte replaces the server's relay fee", async () => {
  const provider = providerWithRelayFee(0.00002);
  Config.RelayFeePerByte = 1.5;
  expect(await getRelayFeeCache(provider)).toBe(1.5);
});
