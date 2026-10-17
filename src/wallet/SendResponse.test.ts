import { decodeTransaction, hashTransaction, hexToBin } from "@bitauth/libauth";
import { expectTypeOf } from "vitest";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { NFTCapability } from "../interface.js";
import { SendRequestOptionsI } from "./interface.js";
import { SignedSendResponse, UnsignedSendResponse } from "./model.js";
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
  response: SignedSendResponse,
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

test("buildUnsigned wins over broadcast: false", async () => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const bob = await RegTestWallet.newRandom();

  const response = await alice.send([[bob.cashaddr, 10_000n]], {
    buildUnsigned: true,
    broadcast: false,
  });
  expectTypeOf(response).toEqualTypeOf<UnsignedSendResponse>();
  expect(response.txId).toBeUndefined();
  expect(response.transaction).toBeUndefined();
  const decoded = decodeTransaction(hexToBin(response.unsignedTransaction));
  if (typeof decoded === "string") throw new Error(decoded);
  expect(decoded.inputs[0].unlockingBytecode.length).toBe(0);
  expect(response.sourceOutputs.length).toBe(decoded.inputs.length);
});

test("options whose buildUnsigned is not known return either, told apart by txId", async () => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const bob = await RegTestWallet.newRandom();

  const options: SendRequestOptionsI = { broadcast: false };
  const response = await alice.send([[bob.cashaddr, 10_000n]], options);
  expectTypeOf(response).toEqualTypeOf<
    SignedSendResponse | UnsignedSendResponse
  >();
  if (response.txId === undefined) throw new Error("expected a signed send");
  expectTypeOf(response.transaction).toEqualTypeOf<string>();
  expect(hashTransaction(hexToBin(response.transaction))).toBe(response.txId);
});
