import { disconnectProviders, initProviders } from "#test/providers.js";
import { getTokenBalance, getTokenUtxos } from "#test/balances.js";
import { NFTCapability, Utxo } from "../interface.js";
import { TokenBurnError } from "./errors.js";
import {
  OpReturnData,
  SendRequest,
  TokenBurnRequest,
  TokenMintRequest,
  TokenSendRequest,
} from "./model.js";
import { RegTestWallet } from "./Wif.js";

// Stands in for a regression in the change: the token outputs going back to this address are
// lost from the transaction the wallet builds, after the change was computed. `extraInputs`
// stands in for one in the coin choice: the selection adds these coins to what it picked.
const dropped = vi.hoisted(() => ({
  tokenaddr: undefined as string | undefined,
  extraInputs: [] as Utxo[],
}));
vi.mock("../transaction/Wif.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../transaction/Wif.js")>();
  type Request = SendRequest | TokenSendRequest | OpReturnData;
  const keep = (requests: Request[]) =>
    requests.filter(
      (request) =>
        !(
          request instanceof TokenSendRequest &&
          request.cashaddr === dropped.tokenaddr
        ),
    );
  return {
    ...original,
    getSuitableUtxos: async (
      ...args: Parameters<typeof original.getSuitableUtxos>
    ) => [
      ...(await original.getSuitableUtxos(...args)),
      ...dropped.extraInputs,
    ],
    buildEncodedTransaction: (
      args: Parameters<typeof original.buildEncodedTransaction>[0],
    ) =>
      original.buildEncodedTransaction({
        ...args,
        outputs: keep(args.outputs),
        tokenChange: keep(args.tokenChange ?? []) as TokenSendRequest[],
      }),
  };
});

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});
afterEach(() => {
  dropped.tokenaddr = undefined;
  dropped.extraInputs = [];
});

const fundedWallet = async () => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const wallet = await RegTestWallet.newRandom();
  await alice.send([
    { cashaddr: wallet.cashaddr, value: 20_000n },
    { cashaddr: wallet.cashaddr, value: 20_000n },
  ]);
  return wallet;
};

const burnError = async (spend: Promise<unknown>) => {
  const error = await spend.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TokenBurnError);
  return error as TokenBurnError;
};

describe("a built transaction that burns tokens is refused", () => {
  test("a send whose fungible token change is dropped", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const category = (await wallet.tokenGenesis({ amount: 100n }))
      .categories![0];
    const utxosBefore = await wallet.getUtxos();
    dropped.tokenaddr = wallet.tokenaddr;

    const error = await burnError(
      wallet.send(
        new TokenSendRequest({
          cashaddr: bob.tokenaddr,
          category,
          amount: 10n,
        }),
      ),
    );
    expect(error.category).toBe(category);
    expect(error.amount).toBe(90n);
    expect(error.nft).toBeUndefined();

    expect(await wallet.getUtxos()).toEqual(utxosBefore);
    expect(await getTokenBalance(bob, category)).toBe(0n);
  });

  test("a send ignores a tokenBurns option smuggled in by untyped code", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const category = (await wallet.tokenGenesis({ amount: 100n }))
      .categories![0];
    dropped.tokenaddr = wallet.tokenaddr;
    const options = { tokenBurns: { fungible: { [category]: 90n } } };

    const request = new TokenSendRequest({
      cashaddr: bob.tokenaddr,
      category,
      amount: 10n,
    });
    const error = await burnError(wallet.send(request, options as any));
    expect(error.amount).toBe(90n);
    expect(await getTokenBalance(bob, category)).toBe(0n);
  });

  test("a send whose NFT change is dropped", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const nft = { capability: NFTCapability.none, commitment: "01" };
    const category = (await wallet.tokenGenesis({ nft })).categories![0];
    const [nftCoin] = await getTokenUtxos(wallet, category);
    dropped.tokenaddr = wallet.tokenaddr;

    const error = await burnError(
      wallet.send(
        { cashaddr: bob.cashaddr, value: 1_000n },
        { ensureUtxos: [nftCoin] },
      ),
    );
    expect(error.category).toBe(category);
    expect(error.amount).toBe(0n);
    expect(error.nft).toEqual(nft);
    expect(await getTokenUtxos(wallet, category)).toEqual([nftCoin]);
  });

  test("a mint whose minting NFT change is dropped", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const nft = { capability: NFTCapability.minting, commitment: "" };
    const category = (await wallet.tokenGenesis({ nft })).categories![0];
    dropped.tokenaddr = wallet.tokenaddr;

    const error = await burnError(
      wallet.tokenMint(
        new TokenMintRequest({
          category,
          cashaddr: bob.tokenaddr,
          nft: { capability: NFTCapability.none, commitment: "0a" },
        }),
      ),
    );
    expect(error.category).toBe(category);
    expect(error.nft).toEqual(nft);
    expect(await getTokenUtxos(bob, category)).toEqual([]);
  });

  test("a burn whose change is dropped burns more than it asked", async () => {
    const wallet = await fundedWallet();
    const category = (await wallet.tokenGenesis({ amount: 100n }))
      .categories![0];
    dropped.tokenaddr = wallet.tokenaddr;

    const burn = (options: { checkTokenQuantities?: boolean }) =>
      wallet.tokenBurn(new TokenBurnRequest({ category, amount: 10n }), "", {
        broadcast: false,
        ...options,
      });
    const error = await burnError(burn({}));
    expect(error.category).toBe(category);
    expect(error.amount).toBe(90n);
    // checkTokenQuantities: false does not turn the check off
    const unchecked = await burnError(burn({ checkTokenQuantities: false }));
    expect(unchecked.amount).toBe(90n);
  });

  test("a fungible burn off a minting NFT whose NFT change is dropped", async () => {
    const wallet = await fundedWallet();
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const category = (await wallet.tokenGenesis({ amount: 10n, nft: minting }))
      .categories![0];
    dropped.tokenaddr = wallet.tokenaddr;

    // all its fungible tokens: what comes back is the minting NFT alone, which the burn keeps
    const error = await burnError(
      wallet.tokenBurn(
        new TokenBurnRequest({ category, nft: minting, amount: 10n }),
        "",
        { broadcast: false },
      ),
    );
    expect(error.category).toBe(category);
    expect(error.amount).toBe(0n);
    expect(error.nft).toEqual(minting);
  });

  test("a burn of one NFT that would destroy an identical one too", async () => {
    const wallet = await fundedWallet();
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const nft = { capability: NFTCapability.none, commitment: "01" };
    const category = (await wallet.tokenGenesis({ nft: minting }))
      .categories![0];
    await wallet.tokenMint([
      new TokenMintRequest({ category, nft }),
      new TokenMintRequest({ category, nft }),
    ]);
    const coins = (await getTokenUtxos(wallet, category)).filter(
      (utxo) => utxo.token!.nft!.capability === NFTCapability.none,
    );
    expect(coins).toHaveLength(2);
    // the burn spends the first coin; the selection adds the second
    dropped.extraInputs = [coins[1]];

    const error = await burnError(
      wallet.tokenBurn(new TokenBurnRequest({ category, nft }), "", {
        excludeUtxoIds: [coins[1]],
        broadcast: false,
      }),
    );
    expect(error.category).toBe(category);
    expect(error.nft).toEqual(nft);
  });
});

describe("a hand-built send with checkTokenQuantities: false", () => {
  test("is refused when it would drop fungible tokens", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const category = (await wallet.tokenGenesis({ amount: 100n }))
      .categories![0];

    // no token change is built, so the 90 tokens the request does not send would be lost
    const error = await burnError(
      wallet.send(
        new TokenSendRequest({
          cashaddr: bob.tokenaddr,
          category,
          amount: 10n,
        }),
        { checkTokenQuantities: false, broadcast: false },
      ),
    );
    expect(error.category).toBe(category);
    expect(error.amount).toBe(90n);
  });

  test("is refused when a token coin it spends funds a BCH output", async () => {
    const wallet = await fundedWallet();
    const nft = { capability: NFTCapability.none, commitment: "01" };
    const category = (await wallet.tokenGenesis({ nft })).categories![0];
    const [coin] = await getTokenUtxos(wallet, category);

    const error = await burnError(
      wallet.send(
        new SendRequest({ cashaddr: wallet.cashaddr, value: 5000n }),
        {
          checkTokenQuantities: false,
          ensureUtxos: [coin],
          broadcast: false,
        },
      ),
    );
    expect(error.nft).toEqual(nft);
  });

  // an identity mint: the authhead, a minting NFT, back at output 0 and new NFTs after it
  test("mints off a minting NFT it brings back", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const category = (await wallet.tokenGenesis({ amount: 10n, nft: minting }))
      .categories![0];
    const [authhead] = await getTokenUtxos(wallet, category);

    const requests = [
      new TokenSendRequest({
        cashaddr: wallet.tokenaddr,
        category,
        amount: 10n,
        nft: minting,
      }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr,
        category,
        nft: { capability: NFTCapability.none, commitment: "0a" },
      }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr,
        category,
        nft: { capability: NFTCapability.mutable, commitment: "0b" },
      }),
    ];
    const { txId } = await wallet.send(requests, {
      tokenOperation: "mint",
      checkTokenQuantities: false,
      ensureUtxos: [authhead],
    });
    const [kept] = await getTokenUtxos(wallet, category);
    expect(kept).toMatchObject({
      txid: txId,
      vout: 0,
      token: { category, amount: 10n, nft: minting },
    });
    expect(
      (await getTokenUtxos(bob, category)).map((utxo) => utxo.token!.nft),
    ).toEqual(
      expect.arrayContaining([
        { capability: NFTCapability.none, commitment: "0a" },
        { capability: NFTCapability.mutable, commitment: "0b" },
      ]),
    );
  });

  test("mints the same way with the token checks left on, the other token coins left out", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const category = (await wallet.tokenGenesis({ nft: minting }))
      .categories![0];
    const [authhead] = await getTokenUtxos(wallet, category);

    const { txId } = await wallet.send(
      [
        new TokenSendRequest({
          cashaddr: wallet.tokenaddr,
          category,
          nft: minting,
        }),
        new TokenSendRequest({
          cashaddr: bob.tokenaddr,
          category,
          nft: { capability: NFTCapability.none, commitment: "0a" },
        }),
      ],
      {
        tokenOperation: "mint",
        tokenUtxoIds: [authhead],
        ensureUtxos: [authhead],
      },
    );
    expect(await getTokenUtxos(wallet, category)).toMatchObject([
      { txid: txId, vout: 0, token: { nft: minting } },
    ]);
    expect(await getTokenUtxos(bob, category)).toHaveLength(1);
  });
});

describe("token operations that conserve or explicitly burn tokens still pass", () => {
  test("a mint, and burns of an NFT and of fungible tokens", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const category = (await wallet.tokenGenesis({ amount: 10n, nft: minting }))
      .categories![0];

    await wallet.tokenMint([
      new TokenMintRequest({
        category,
        cashaddr: wallet.tokenaddr,
        nft: { capability: NFTCapability.none, commitment: "0a" },
      }),
      new TokenMintRequest({
        category,
        cashaddr: bob.tokenaddr,
        nft: { capability: NFTCapability.none, commitment: "0b" },
      }),
    ]);
    expect(await getTokenBalance(wallet, category)).toBe(10n);

    await wallet.tokenBurn(
      new TokenBurnRequest({
        category,
        nft: { capability: NFTCapability.none, commitment: "0a" },
      }),
    );
    await wallet.tokenBurn(
      new TokenBurnRequest({ category, nft: minting, amount: 3n }),
    );
    const left = await getTokenUtxos(wallet, category);
    expect(left.map((utxo) => utxo.token)).toEqual([
      { category, amount: 7n, nft: minting },
    ]);
    expect(await getTokenUtxos(bob, category)).toHaveLength(1);
  });
});
