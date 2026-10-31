import { RegTestWallet, Wallet } from "../wallet/Wif.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { createProvider } from "./default.js";
import { liveTests } from "#test/live.js";

beforeAll(async () => {
  await initProviders();
});

afterAll(async () => {
  await disconnectProviders();
});

test.skipIf(!liveTests)("Should connect to mainnet", async () => {
  process.setMaxListeners(0);

  let wallet = await Wallet.newRandom();
  expect(wallet.provider == globalThis.BCH).toBeTruthy();
  expect(await wallet.getBalance()).toBe(0n);

  const relayFee = await globalThis.BCH.getRelayFee();
  expect(relayFee).toBeGreaterThan(0);
});

test.skipIf(!liveTests)(
  "Should use global provider when creating testnet wallet",
  async () => {
    let wallet = await Wallet.newRandom("", { network: "testnet" });
    expect(wallet.provider == globalThis.tBCH).toBeTruthy();
    expect(await wallet.getBalance()).toBe(0n);

    const relayFee = await globalThis.tBCH.getRelayFee();
    expect(relayFee).toBeGreaterThan(0);
  },
);

test.skip("Should lower overhead in creating wallets", async () => {
  process.setMaxListeners(0);
  for (let i = 0; i < 100; i++) {
    let wallet = await RegTestWallet.newRandom();
    expect(wallet.provider == globalThis.rBCH).toBeTruthy();
    expect(await wallet.getBalance()).toBe(0n);
  }

  const relayFee = await globalThis.rBCH.getRelayFee();
  expect(relayFee).toBeGreaterThan(0);
});

test.skipIf(!liveTests)(
  "Should create a provider with custom servers",
  async () => {
    let provider = await createProvider(
      "mainnet",
      "wss://fulcrum.pat.mn:50004",
    );
    await provider.connect();
    expect(provider == globalThis.BCH).toBeFalsy();
    const relayFee = await provider.getRelayFee();
    expect(relayFee).toBeGreaterThan(0);
    await provider.disconnect();
  },
);
