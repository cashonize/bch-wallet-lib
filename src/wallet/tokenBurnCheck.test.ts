import { disconnectProviders, initProviders } from "#test/providers.js";
import { getTokenBalance, getTokenUtxos } from "#test/balances.js";
import { NFTCapability } from "../interface.js";
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
// lost from the transaction the wallet builds, after the change was computed.
const dropped = vi.hoisted(() => ({
  tokenaddr: undefined as string | undefined,
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
    // the caller can still turn the check off
    await expect(burn({ checkTokenQuantities: false })).resolves.toBeDefined();
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
