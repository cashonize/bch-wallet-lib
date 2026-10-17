import { disconnectProviders, initProviders } from "#test/providers.js";
import { getTokenUtxos } from "#test/balances.js";
import { NFTCapability } from "../interface.js";
import { InvalidRequestError } from "./errors.js";
import {
  TokenBurnRequest,
  TokenGenesisRequest,
  TokenMintRequest,
  TokenSendRequest,
} from "./model.js";
import { RegTestWallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

const category = "11".repeat(32);
const none = NFTCapability.none;
const maxAmount = 2n ** 63n - 1n;

function invalid(build: () => unknown, field: string, value: unknown) {
  let error: unknown;
  try {
    build();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(InvalidRequestError);
  expect((error as InvalidRequestError).field).toBe(field);
  expect((error as InvalidRequestError).value).toEqual(value);
}

describe("request constructors", () => {
  test("a category must be 64 hex characters", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    for (const bad of ["", "11".repeat(31), "11".repeat(33), "zz".repeat(32)]) {
      invalid(
        () => new TokenSendRequest({ cashaddr, category: bad, amount: 1n }),
        "category",
        bad,
      );
      invalid(
        () =>
          new TokenMintRequest({
            category: bad,
            nft: { capability: none, commitment: "" },
          }),
        "category",
        bad,
      );
      invalid(
        () => new TokenBurnRequest({ category: bad, amount: 1n }),
        "category",
        bad,
      );
    }
    expect(
      new TokenSendRequest({ cashaddr, category: "AB".repeat(32), amount: 1n })
        .category,
    ).toBe("AB".repeat(32));
  });

  test("a commitment must be even-length hex of at most 128 bytes", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    for (const bad of ["abc", "test", "0x00", "ab".repeat(129)]) {
      const nft = { capability: none, commitment: bad };
      invalid(
        () => new TokenSendRequest({ cashaddr, category, nft }),
        "nft.commitment",
        bad,
      );
      invalid(() => new TokenGenesisRequest({ nft }), "nft.commitment", bad);
      invalid(
        () => new TokenMintRequest({ category, nft }),
        "nft.commitment",
        bad,
      );
      invalid(
        () => new TokenBurnRequest({ category, nft }),
        "nft.commitment",
        bad,
      );
    }
    for (const good of ["", "00", "ABcd", "ab".repeat(128)]) {
      const nft = { capability: none, commitment: good };
      expect(new TokenSendRequest({ cashaddr, category, nft }).nft).toBe(nft);
      expect(new TokenMintRequest({ category, nft }).nft).toBe(nft);
    }
  });

  test("a fungible amount must be from 0 to 2^63-1", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    for (const bad of [-1n, maxAmount + 1n, 1.5, "1e3"] as any[]) {
      invalid(
        () => new TokenSendRequest({ cashaddr, category, amount: bad }),
        "amount",
        bad,
      );
      invalid(() => new TokenGenesisRequest({ amount: bad }), "amount", bad);
      invalid(
        () => new TokenBurnRequest({ category, amount: bad }),
        "amount",
        bad,
      );
    }
    expect(
      new TokenSendRequest({ cashaddr, category, amount: maxAmount }).amount,
    ).toBe(maxAmount);
    expect(
      new TokenSendRequest({ cashaddr, category, amount: 5 as any }).amount,
    ).toBe(5n);
  });

  test("a token output needs a positive amount or an NFT", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    invalid(
      () => new TokenSendRequest({ cashaddr, category }),
      "nft",
      undefined,
    );
    invalid(
      () => new TokenSendRequest({ cashaddr, category, amount: 0n }),
      "nft",
      undefined,
    );
    invalid(() => new TokenGenesisRequest({}), "nft", undefined);
    invalid(() => new TokenGenesisRequest({ amount: 0n }), "nft", undefined);
    invalid(() => new TokenMintRequest({ category }), "nft", undefined);
    // an NFT alone, or fungible tokens alone, are both outputs
    expect(
      new TokenSendRequest({
        cashaddr,
        category,
        nft: { capability: none, commitment: "" },
      }).amount,
    ).toBe(0n);
    expect(new TokenGenesisRequest({ amount: 1n }).amount).toBe(1n);
  });
});

describe("token operations validate plain request objects before reading any coin", () => {
  test.each([
    [
      "send with an odd-length commitment",
      (w: RegTestWallet) =>
        w.send({
          cashaddr: w.tokenaddr,
          category,
          nft: { capability: none, commitment: "abc" },
        } as TokenSendRequest),
      "nft.commitment",
    ],
    [
      "genesis with a negative amount",
      (w: RegTestWallet) => w.tokenGenesis({ amount: -1n }),
      "amount",
    ],
    [
      "genesis with neither amount nor NFT",
      (w: RegTestWallet) => w.tokenGenesis({ cashaddr: w.tokenaddr }),
      "nft",
    ],
    [
      "mint with a short category",
      (w: RegTestWallet) =>
        w.tokenMint({
          category: "11",
          nft: { capability: none, commitment: "" },
        }),
      "category",
    ],
    [
      "mint without an NFT",
      (w: RegTestWallet) => w.tokenMint({ category }),
      "nft",
    ],
    [
      "mint with a 129-byte commitment",
      (w: RegTestWallet) =>
        w.tokenMint({
          category,
          nft: { capability: none, commitment: "ab".repeat(129) },
        }),
      "nft.commitment",
    ],
    [
      "burn above 2^63-1",
      (w: RegTestWallet) => w.tokenBurn({ category, amount: maxAmount + 1n }),
      "amount",
    ],
  ])("%s", async (_, operation, field) => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const getUtxos = vi.spyOn(alice, "getUtxos");

    const error = await (operation(alice) as Promise<unknown>).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as InvalidRequestError).field).toBe(field);
    expect(getUtxos).not.toHaveBeenCalled();
  });

  test("a 128-byte commitment and the largest amount go on chain", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const commitment = "ab".repeat(128);
    const genesis = await alice.tokenGenesis({
      cashaddr: alice.tokenaddr,
      amount: maxAmount,
      value: 2000n,
      nft: { capability: NFTCapability.minting, commitment },
    });
    const [utxo] = await getTokenUtxos(alice, genesis.categories[0]);
    expect(utxo.token?.amount).toBe(maxAmount);
    expect(utxo.token?.nft?.commitment).toBe(commitment);
  });
});
