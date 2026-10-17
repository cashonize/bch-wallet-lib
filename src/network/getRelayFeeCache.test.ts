import { randomUtxo } from "@paryonusd/mem-cash";
import { Config } from "../config.js";
import { Network } from "../interface.js";
import { RegTestWallet } from "../wallet/Wif.js";
import { SendRequest } from "../wallet/model.js";
import { removeGlobalProvider, setGlobalProvider } from "./default.js";
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
  Config.MaxRelayFeePerByte = 10;
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

test("bounds the server's relay fee to [1, Config.MaxRelayFeePerByte]", async () => {
  expect(await getRelayFeeCache(providerWithRelayFee(0))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(-0.001))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(NaN))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(0.000005))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(0.00005))).toBe(5);
  const absurd = providerWithRelayFee(0.5);
  expect(await getRelayFeeCache(absurd)).toBe(10);
  Config.MaxRelayFeePerByte = 20;
  expect(await getRelayFeeCache(absurd)).toBe(20);
});

test("Config.RelayFeePerByte is not bounded by Config.MaxRelayFeePerByte", async () => {
  Config.RelayFeePerByte = 50;
  expect(await getRelayFeeCache(providerWithRelayFee(0.00001))).toBe(50);
});

test("a server reporting an absurd relay fee cannot make a send overpay", async () => {
  // 0.5 BCH/kB, 50,000 sat/byte: unchecked, this send would pay over 0.1 BCH in fees
  const provider = providerWithRelayFee(0.5);
  await provider.ready();
  setGlobalProvider(Network.REGTEST, provider);
  try {
    const alice = await RegTestWallet.newRandom();
    const bob = await RegTestWallet.newRandom();
    await provider.addUtxo(alice.cashaddr, {
      ...randomUtxo({ satoshis: 100_000_000n }),
      height: 100,
    });

    const response = await alice.send(
      new SendRequest({ cashaddr: bob.cashaddr, value: 10_000n }),
    );

    const tx = await alice.provider.getRawTransactionObject(response.txId!);
    const outputTotal = tx.vout.reduce(
      (sum, output) => sum + BigInt(Math.round(output.value * 1e8)),
      0n,
    );
    const fee = 100_000_000n - outputTotal;
    // 10 sat/byte, plus the 1 satoshi the fee calculation rounds up by
    expect(fee).toBe(BigInt(tx.size * 10 + 1));
  } finally {
    removeGlobalProvider(Network.REGTEST);
  }
});
