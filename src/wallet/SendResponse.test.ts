import { hashTransaction, hexToBin } from "@bitauth/libauth";
import { expectTypeOf } from "vitest";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { NFTCapability } from "../interface.js";
import { SendResponse } from "./model.js";
import { RegTestWallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

// The returned hex is the transaction with the returned txId, and the one the server got
const expectBroadcast = async (
  wallet: RegTestWallet,
  response: SendResponse,
) => {
  expect(hashTransaction(hexToBin(response.transaction))).toBe(response.txId);
  expect(await wallet.provider.getRawTransaction(response.txId)).toBe(
    response.transaction,
  );
};

describe("a broadcast send returns the transaction it broadcast", () => {
  test("send", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    const response = await alice.send([[bob.cashaddr, 10_000n]]);
    expectTypeOf(response.txId).toEqualTypeOf<string>();
    expectTypeOf(response.transaction).toEqualTypeOf<string>();
    await expectBroadcast(alice, response);
    expect(response.explorerUrl).toContain(response.txId);
  });

  test("sendMax", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send([[bob.cashaddr, 10_000n]]);

    const response = await bob.sendMax(alice.cashaddr);
    expectTypeOf(response.txId).toEqualTypeOf<string>();
    await expectBroadcast(bob, response);
  });

  test("token genesis, mint and burn", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const nft = { capability: NFTCapability.minting, commitment: "" };

    const genesis = await alice.tokenGenesis({ amount: 100n, nft });
    expectTypeOf(genesis.txId).toEqualTypeOf<string>();
    await expectBroadcast(alice, genesis);
    const category = genesis.categories[0];

    const mint = await alice.tokenMint({
      category,
      nft: { capability: NFTCapability.none, commitment: "01" },
    });
    await expectBroadcast(alice, mint);

    const burn = await alice.tokenBurn({ category, amount: 10n, nft });
    await expectBroadcast(alice, burn);
  });
});

test("broadcast: false returns the signed transaction it did not broadcast", async () => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const bob = await RegTestWallet.newRandom();

  const response = await alice.send([[bob.cashaddr, 10_000n]], {
    broadcast: false,
  });
  expectTypeOf(response.txId).toEqualTypeOf<string>();
  expect(hashTransaction(hexToBin(response.transaction))).toBe(response.txId);
  await expect(
    alice.provider.getRawTransaction(response.txId),
  ).rejects.toThrow();
});
