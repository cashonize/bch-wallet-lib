import {
  decodeTransaction,
  encodeTransaction,
  hexToBin,
} from "@bitauth/libauth";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { NFTCapability } from "../interface.js";
import { BroadcastRejectedError } from "../network/errors.js";
import { InsufficientFundsError } from "./errors.js";
import { TokenSendRequest } from "./model.js";
import { RegTestWallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

const category = "11".repeat(32);

async function shortfall(spend: Promise<unknown>) {
  const error = await spend.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InsufficientFundsError);
  return error as InsufficientFundsError;
}

describe("insufficient funds are an InsufficientFundsError", () => {
  test("too little BCH", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr, value: 10_000n });

    const error = await shortfall(
      bob.send({ cashaddr: alice.cashaddr, value: 20_000n }),
    );
    expect(error.message).toMatch(/^Amount required was not met/);
    expect(error.asset).toBe("bch");
  });

  test("no coins at all", async () => {
    const bob = await RegTestWallet.newRandom();
    const error = await shortfall(
      bob.send({ cashaddr: bob.cashaddr, value: 1_000n }),
    );
    expect(error.message).toBe("There were no Unspent Outputs");
    expect(error.asset).toBe("bch");
  });

  test("too few vout=0 coins for a genesis", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr, value: 10_000n });

    const error = await shortfall(
      bob.tokenGenesis([{ amount: 1n }, { amount: 2n }]),
    );
    expect(error.message).toMatch(/^Not enough vout=0 inputs/);
  });

  test("too few fungible tokens", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesis = await alice.tokenGenesis({ amount: 100n });
    const ftCategory = genesis.categories![0];

    const error = await shortfall(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.tokenaddr,
          amount: 101n,
          category: ftCategory,
        }),
      ),
    );
    expect(error.message).toBe("Not enough token amount to send");
    expect(error.asset).toBe("token");
    expect(error.category).toBe(ftCategory);
    expect(error.required).toBe(101n);
    expect(error.available).toBe(100n);
  });

  test("no coin of the NFT to send", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const error = await shortfall(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.tokenaddr,
          category,
          nft: { capability: NFTCapability.none, commitment: "abcd" },
        }),
      ),
    );
    expect(error.message).toMatch(/^No suitable token utxos available/);
    expect(error.asset).toBe("token");
    expect(error.category).toBe(category);
  });

  test("no minting NFT to mint with", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const error = await shortfall(
      alice.tokenMint({
        category,
        nft: { capability: NFTCapability.none, commitment: "" },
      }),
    );
    expect(error.message).toMatch(
      /^You do not have any token UTXOs with minting capability/,
    );
    expect(error.category).toBe(category);
  });

  test("no token coins to burn", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const error = await shortfall(alice.tokenBurn({ category, amount: 1n }));
    expect(error.message).toMatch(/^You do not have suitable token UTXOs/);
    expect(error.category).toBe(category);
  });

  test("too few fungible tokens to burn", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesis = await alice.tokenGenesis({ amount: 100n });
    const ftCategory = genesis.categories![0];

    const error = await shortfall(
      alice.tokenBurn({ category: ftCategory, amount: 101n }),
    );
    expect(error.asset).toBe("token");
    expect(error.required).toBe(101n);
    expect(error.available).toBe(100n);
  });
});

describe("a refused broadcast is a BroadcastRejectedError", () => {
  test("a double spend", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr, value: 10_000n });

    // two spends of bob's one coin, built before either is broadcast
    const first = await bob.send(
      { cashaddr: alice.cashaddr, value: 5_000n },
      {
        broadcast: false,
      },
    );
    const second = await bob.send(
      { cashaddr: alice.cashaddr, value: 6_000n },
      {
        broadcast: false,
      },
    );
    await bob.submitTransaction(hexToBin(first.transaction));

    const error = await bob
      .submitTransaction(hexToBin(second.transaction))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BroadcastRejectedError);
    const rejected = error as BroadcastRejectedError;
    expect(rejected.reason).toBe("txn-mempool-conflict");
    expect(rejected.txid).toBe(second.txId);
    expect(rejected.alreadyKnown).toBe(false);
    expect(rejected.message).toBe(
      "the transaction was rejected by network rules.\n\ntxn-mempool-conflict (code 18)\n",
    );
  });

  test("a spend of a coin the node does not have", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr, value: 10_000n });
    const spend = await bob.send(
      { cashaddr: alice.cashaddr, value: 5_000n },
      {
        broadcast: false,
      },
    );
    // the same spend from a coin that never existed
    const transaction = decodeTransaction(hexToBin(spend.transaction));
    if (typeof transaction === "string") throw new Error(transaction);
    transaction.inputs[0].outpointTransactionHash = hexToBin("55".repeat(32));

    const error = await bob
      .submitTransaction(encodeTransaction(transaction))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BroadcastRejectedError);
    expect((error as BroadcastRejectedError).reason).toBe("Missing inputs");
  });
});
