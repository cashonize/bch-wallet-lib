import { disconnectProviders, initProviders } from "#test/providers.js";
import { getTokenUtxos } from "#test/balances.js";
import { NFTCapability } from "../interface.js";
import { InvalidRequestError } from "./errors.js";
import {
  SendRequest,
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
  test("a satoshi value must be an integer from 1 to 21e14", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    for (const bad of [0n, -1n, 1.5, 2_100_000_000_000_001n]) {
      invalid(
        () => new SendRequest({ cashaddr, value: bad as bigint }),
        "value",
        bad,
      );
    }
    invalid(
      () =>
        new TokenSendRequest({ cashaddr, category, amount: 1n, value: -1n }),
      "value",
      -1n,
    );
    invalid(
      () => new TokenGenesisRequest({ amount: 1n, value: 1.5 as any }),
      "value",
      1.5,
    );
    invalid(
      () =>
        new TokenMintRequest({
          category,
          nft: { capability: none, commitment: "" },
          value: 2_100_000_000_000_001n,
        }),
      "value",
      2_100_000_000_000_001n,
    );
    expect(new SendRequest({ cashaddr, value: 546 as any }).value).toBe(546n);
    // a token output without a value, or of 0, holds the default
    expect(
      new TokenSendRequest({ cashaddr, category, amount: 1n, value: 0n }).value,
    ).toBeUndefined();
  });

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
  });

  test("the commitment of a send or burn request is lowercased", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    const nft = { capability: none, commitment: "AB" };
    expect(new TokenSendRequest({ cashaddr, category, nft }).nft).toEqual({
      capability: none,
      commitment: "ab",
    });
    expect(new TokenBurnRequest({ category, nft }).nft).toEqual({
      capability: none,
      commitment: "ab",
    });
    expect(nft.commitment).toBe("AB");
  });

  test("a category is lowercased", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    const upper = "AB".repeat(32);
    const nft = { capability: none, commitment: "" };
    expect(
      new TokenSendRequest({ cashaddr, category: upper, amount: 1n }).category,
    ).toBe("ab".repeat(32));
    expect(new TokenMintRequest({ category: upper, nft }).category).toBe(
      "ab".repeat(32),
    );
    expect(new TokenBurnRequest({ category: upper, amount: 1n }).category).toBe(
      "ab".repeat(32),
    );
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
      const lowercased = { capability: none, commitment: good.toLowerCase() };
      expect(new TokenSendRequest({ cashaddr, category, nft }).nft).toEqual(
        lowercased,
      );
      expect(new TokenMintRequest({ category, nft }).nft).toBe(nft);
    }
  });

  test("an NFT request without a commitment is refused rather than guessed", async () => {
    const cashaddr = (await RegTestWallet.newRandom()).tokenaddr;
    const nft = { capability: none } as any;
    invalid(
      () => new TokenSendRequest({ cashaddr, category, nft }),
      "nft.commitment",
      undefined,
    );
    // without a capability it stays a fungible-only request
    const fungible = new TokenSendRequest({
      cashaddr,
      category,
      amount: 5n,
      nft: {} as any,
    });
    expect(fungible.nft?.commitment).toBeUndefined();
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
    // a burn of nothing
    invalid(() => new TokenBurnRequest({ category }), "nft", undefined);
    invalid(
      () => new TokenBurnRequest({ category, amount: 0n }),
      "nft",
      undefined,
    );
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

describe("a category in uppercase finds its coins", () => {
  // bob holds a minting NFT with 100 fungible tokens of its category
  const withBaton = async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr!, value: 100_000n });
    const genesis = await bob.tokenGenesis({
      amount: 100n,
      nft: { capability: NFTCapability.minting, commitment: "" },
    });
    const category = genesis.categories[0];
    return { bob, category, upper: category.toUpperCase() };
  };

  test("send", async () => {
    const { bob, category, upper } = await withBaton();
    const carol = await RegTestWallet.newRandom();

    const response = await bob.send({
      cashaddr: carol.tokenaddr!,
      category: upper,
      amount: 30n,
    } as TokenSendRequest);

    expect(response.categories).toEqual([category]);
    const [coin] = await getTokenUtxos(carol, category);
    expect(coin.token?.amount).toBe(30n);
  });

  test("tokenMint, from a request or a plain object", async () => {
    const { bob, category, upper } = await withBaton();
    const nft = { capability: none, commitment: "01" };

    await bob.tokenMint(new TokenMintRequest({ category: upper, nft }));
    const plain = { category: upper, nft };
    await bob.tokenMint(plain);

    expect(plain.category).toBe(upper);
    const minted = (await getTokenUtxos(bob, category)).filter(
      (utxo) => utxo.token?.nft?.capability === none,
    );
    expect(minted).toHaveLength(2);
  });

  test("tokenBurn, from a request or a plain object", async () => {
    const { bob, category, upper } = await withBaton();
    // fungible tokens off the baton's coin, which comes back
    const nft = { capability: NFTCapability.minting, commitment: "" };

    await bob.tokenBurn(
      new TokenBurnRequest({ category: upper, amount: 10n, nft }),
    );
    const plain = { category: upper, amount: 10n, nft };
    await bob.tokenBurn(plain);

    expect(plain.category).toBe(upper);
    const [baton] = await getTokenUtxos(bob, category);
    expect(baton.token?.amount).toBe(80n);
  });
});

describe("a commitment in uppercase names its NFT", () => {
  // bob holds two immutable NFTs of one category, "aa" and "bb"
  const twoNfts = async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr!, value: 100_000n });
    const genesis = await bob.tokenGenesis({
      nft: { capability: NFTCapability.minting, commitment: "" },
    });
    const category = genesis.categories[0];
    await bob.tokenMint([
      new TokenMintRequest({
        category,
        nft: { capability: none, commitment: "aa" },
      }),
      new TokenMintRequest({
        category,
        nft: { capability: none, commitment: "bb" },
      }),
    ]);
    const commitments = async (wallet: RegTestWallet) =>
      (await getTokenUtxos(wallet, category))
        .filter((utxo) => utxo.token?.nft?.capability === none)
        .map((utxo) => utxo.token!.nft!.commitment)
        .sort();
    return { bob, category, commitments };
  };

  test("send", async () => {
    const { bob, category, commitments } = await twoNfts();
    const carol = await RegTestWallet.newRandom();

    await bob.send(
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category,
        nft: { capability: none, commitment: "BB" },
      }),
    );

    expect(await commitments(bob)).toEqual(["aa"]);
    expect(await commitments(carol)).toEqual(["bb"]);
  });

  test("tokenBurn, from a request or a plain object", async () => {
    const { bob, category, commitments } = await twoNfts();

    await bob.tokenBurn(
      new TokenBurnRequest({
        category,
        nft: { capability: none, commitment: "BB" },
      }),
    );
    expect(await commitments(bob)).toEqual(["aa"]);
    const nft = { capability: none, commitment: "AA" };
    await bob.tokenBurn({ category, nft });
    expect(nft.commitment).toBe("AA");
    expect(await commitments(bob)).toEqual([]);
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
      "burn of neither fungible tokens nor an NFT",
      (w: RegTestWallet) => w.tokenBurn({ category }),
      "nft",
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

  test("a coin with a 128-byte commitment and fungible tokens is sent on", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const nft = { capability: none, commitment: "cd".repeat(128) };
    const genesis = await alice.tokenGenesis({
      cashaddr: alice.tokenaddr,
      amount: 500n,
      value: 2000n,
      nft,
    });
    const category = genesis.categories![0];
    await alice.send(
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category,
        amount: 500n,
        nft,
      }),
    );
    const [utxo] = await getTokenUtxos(bob, category);
    expect(utxo.token?.amount).toBe(500n);
    expect(utxo.token?.nft?.commitment).toBe(nft.commitment);
  });
});

describe("the extra outputs of a token genesis", () => {
  test("refuse a category other than the new one, and send the new one", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const carol = await RegTestWallet.newRandom();
    // bob's one coin, at vout 0, is the one the genesis spends
    const { txId } = await alice.send({
      cashaddr: bob.cashaddr,
      value: 10_000n,
    });
    const submit = vi.spyOn(bob, "submitTransaction");

    const error = await bob
      .tokenGenesis({ amount: 100n }, [
        new TokenSendRequest({
          cashaddr: carol.tokenaddr,
          category,
          amount: 1n,
        }),
      ])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as InvalidRequestError).field).toBe("sendRequests");
    expect(submit).not.toHaveBeenCalled();

    await bob.tokenGenesis({ amount: 100n }, [
      new TokenSendRequest({
        cashaddr: carol.tokenaddr,
        category: txId.toUpperCase(),
        amount: 5n,
      }),
    ]);
    const [utxo] = await getTokenUtxos(carol, txId);
    expect(utxo.token?.amount).toBe(5n);
  });
});
