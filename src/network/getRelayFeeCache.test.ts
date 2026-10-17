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

test("floors the server's relay fee at 1 sat/byte", async () => {
  expect(await getRelayFeeCache(providerWithRelayFee(0))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(-0.001))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(NaN))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(Infinity))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(0.000005))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(0.00005))).toBe(5);
  expect(await getRelayFeeCache(providerWithRelayFee(0.0001))).toBe(10);
});

test("caps the server's relay fee at Config.MaxRelayFeePerByte", async () => {
  const absurd = providerWithRelayFee(0.5);
  expect(await getRelayFeeCache(absurd)).toBe(10);
  Config.MaxRelayFeePerByte = 20;
  expect(await getRelayFeeCache(absurd)).toBe(20);
});

test("a Config.MaxRelayFeePerByte below 1 still gives 1 sat/byte", async () => {
  Config.MaxRelayFeePerByte = 0.5;
  expect(await getRelayFeeCache(providerWithRelayFee(0.00001))).toBe(1);
  expect(await getRelayFeeCache(providerWithRelayFee(0.000002))).toBe(1);
  Config.MaxRelayFeePerByte = 0;
  expect(await getRelayFeeCache(providerWithRelayFee(0))).toBe(1);
});

test("Config.RelayFeePerByte is floored at 1 sat/byte", async () => {
  Config.RelayFeePerByte = 0.5;
  expect(await getRelayFeeCache(providerWithRelayFee(0.00002))).toBe(1);
  Config.RelayFeePerByte = 0;
  expect(await getRelayFeeCache(providerWithRelayFee(0.00002))).toBe(1);
});

test("Config.RelayFeePerByte is not bounded by Config.MaxRelayFeePerByte", async () => {
  Config.RelayFeePerByte = 50;
  expect(await getRelayFeeCache(providerWithRelayFee(0.00001))).toBe(50);
});

test.each([NaN, -1, Infinity, -Infinity, "5", null])(
  "rejects %s as a fee setting, naming the setting",
  async (value) => {
    const provider = providerWithRelayFee(0.00001);
    Config.RelayFeePerByte = value as number;
    await expect(getRelayFeeCache(provider)).rejects.toThrow(
      /^Config\.RelayFeePerByte must be/,
    );
    Config.RelayFeePerByte = undefined;
    Config.MaxRelayFeePerByte = value as number;
    await expect(getRelayFeeCache(provider)).rejects.toThrow(
      /^Config\.MaxRelayFeePerByte must be/,
    );
    // checked even when RelayFeePerByte is set, so a bad cap does not wait for it to be unset
    Config.RelayFeePerByte = 2;
    await expect(getRelayFeeCache(provider)).rejects.toThrow(
      /^Config\.MaxRelayFeePerByte must be/,
    );
  },
);

// Funds a new wallet on a chain whose server reports the given relay fee, sends from it and returns
// the fee the transaction paid and its size
async function sendWithRelayFee(relayFeePerKbInCoins: number) {
  const provider = providerWithRelayFee(relayFeePerKbInCoins);
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
    return { fee: 100_000_000n - outputTotal, size: tx.size };
  } finally {
    removeGlobalProvider(Network.REGTEST);
  }
}

// the fee at a rate, plus the 1 satoshi the fee calculation rounds up by
const feeAt = (size: number, feePerByte: number) =>
  BigInt(size * feePerByte + 1);

test("a server reporting an absurd relay fee cannot make a send overpay", async () => {
  // 0.5 BCH/kB, 50,000 sat/byte: unchecked, this send would pay over 0.1 BCH in fees
  const { fee, size } = await sendWithRelayFee(0.5);
  expect(fee).toBe(feeAt(size, 10));
});

test("a send pays the server's relay fee within the cap", async () => {
  const { fee, size } = await sendWithRelayFee(0.00005);
  expect(fee).toBe(feeAt(size, 5));
});

test("a send under an invalid server relay fee pays 1 sat/byte", async () => {
  for (const relayFee of [NaN, -0.001, 0]) {
    const { fee, size } = await sendWithRelayFee(relayFee);
    expect(fee).toBe(feeAt(size, 1));
  }
});

test("a send under a Config.MaxRelayFeePerByte below 1 pays 1 sat/byte", async () => {
  Config.MaxRelayFeePerByte = 0.5;
  const { fee, size } = await sendWithRelayFee(0.00001);
  expect(fee).toBe(feeAt(size, 1));
});

test("a send under an invalid fee setting rejects before anything is built", async () => {
  Config.MaxRelayFeePerByte = NaN;
  await expect(sendWithRelayFee(0.00001)).rejects.toThrow(
    /^Config\.MaxRelayFeePerByte must be/,
  );
});
