import { disconnectProviders, initProviders } from "#test/providers.js";
import { NFTCapability } from "../interface.js";
import { allocateFee } from "../transaction/allocateFee.js";
import { asSendRequestObject } from "../util/asSendRequestObject.js";
import { FeePaidByEnum } from "./enum.js";
import { InsufficientFundsError } from "./errors.js";
import { SendRequest, TokenSendRequest } from "./model.js";
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
    await alice.send([[bob.cashaddr, 10_000n]]);

    const error = await shortfall(bob.send([[alice.cashaddr, 20_000n]]));
    expect(error.message).toMatch(/^Amount required was not met/);
    expect(error.asset).toBe("bch");
  });

  test("no coins at all", async () => {
    const bob = await RegTestWallet.newRandom();
    const error = await shortfall(bob.send([[bob.cashaddr, 1_000n]]));
    expect(error.message).toBe("There were no Unspent Outputs");
    expect(error.asset).toBe("bch");
  });

  test("too few vout=0 coins for a genesis", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send([[bob.cashaddr, 10_000n]]);

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

  test("outputs that cannot pay the fee", () => {
    const requests = asSendRequestObject([
      ["alice", 2000n],
      ["bob", 2000n],
    ]) as SendRequest[];
    expect(() => allocateFee(requests, 7000n, FeePaidByEnum.any, 0n)).toThrow(
      InsufficientFundsError,
    );
  });
});
