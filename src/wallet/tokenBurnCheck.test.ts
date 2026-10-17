import { disconnectProviders, initProviders } from "#test/providers.js";
import { NFTCapability } from "../interface.js";
import type { OutputOrderingFn } from "../transaction/coin-control/types.js";
import { TokenBurnError } from "./errors.js";
import {
  TokenBurnRequest,
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

const fundedWallet = async () => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const wallet = await RegTestWallet.newRandom();
  await alice.send([
    [wallet.cashaddr, 20_000n],
    [wallet.cashaddr, 20_000n],
  ]);
  return wallet;
};

// an outputOrdering hook that loses the token outputs going back to the wallet: its token change
const dropTokenChange =
  (wallet: RegTestWallet): OutputOrderingFn =>
  ({ outputs }) =>
    outputs.filter(
      (output) =>
        !(
          output instanceof TokenSendRequest &&
          output.cashaddr === wallet.tokenaddr
        ),
    );

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

    const send = (options: { buildUnsigned?: boolean }) =>
      wallet.send(
        new TokenSendRequest({
          cashaddr: bob.tokenaddr,
          category,
          amount: 10n,
        }),
        { outputOrdering: dropTokenChange(wallet), ...options },
      );
    const error = await burnError(send({}));
    expect(error.category).toBe(category);
    expect(error.amount).toBe(90n);
    expect(error.nft).toBeUndefined();
    // nothing is built either
    await burnError(send({ buildUnsigned: true }));

    expect(await wallet.getUtxos()).toEqual(utxosBefore);
    expect(await bob.getTokenBalance(category)).toBe(0n);
  });

  test("a send whose NFT change is dropped", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const nft = { capability: NFTCapability.none, commitment: "01" };
    const category = (await wallet.tokenGenesis({ nft })).categories![0];
    const [nftCoin] = await wallet.getTokenUtxos(category);

    const error = await burnError(
      wallet.send([[bob.cashaddr, 1_000n]], {
        ensureUtxos: [nftCoin],
        outputOrdering: dropTokenChange(wallet),
      }),
    );
    expect(error.category).toBe(category);
    expect(error.amount).toBe(0n);
    expect(error.nft).toEqual(nft);
    expect(await wallet.getTokenUtxos(category)).toEqual([nftCoin]);
  });

  test("a mint whose minting NFT change is dropped", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const nft = { capability: NFTCapability.minting, commitment: "" };
    const category = (await wallet.tokenGenesis({ nft })).categories![0];

    const error = await burnError(
      wallet.tokenMint(
        new TokenMintRequest({
          category,
          cashaddr: bob.tokenaddr,
          nft: { capability: NFTCapability.none, commitment: "0a" },
        }),
        false,
        { outputOrdering: dropTokenChange(wallet) },
      ),
    );
    expect(error.category).toBe(category);
    expect(error.nft).toEqual(nft);
    expect(await bob.getTokenUtxos(category)).toEqual([]);
  });

  test("a burn whose change is dropped burns more than it asked", async () => {
    const wallet = await fundedWallet();
    const category = (await wallet.tokenGenesis({ amount: 100n }))
      .categories![0];

    const burn = (options: { checkTokenQuantities?: boolean }) =>
      wallet.tokenBurn(new TokenBurnRequest({ category, amount: 10n }), "", {
        outputOrdering: dropTokenChange(wallet),
        buildUnsigned: true,
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
  test("a mint that deducts its fungible tokens, and burns of an NFT and of fungible tokens", async () => {
    const wallet = await fundedWallet();
    const bob = await RegTestWallet.newRandom();
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const category = (await wallet.tokenGenesis({ amount: 10n, nft: minting }))
      .categories![0];

    await wallet.tokenMint(
      [
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
      ],
      true,
    );
    expect(await wallet.getTokenBalance(category)).toBe(8n);

    await wallet.tokenBurn(
      new TokenBurnRequest({
        category,
        nft: { capability: NFTCapability.none, commitment: "0a" },
      }),
    );
    await wallet.tokenBurn(
      new TokenBurnRequest({ category, nft: minting, amount: 3n }),
    );
    const left = await wallet.getTokenUtxos(category);
    expect(left.map((utxo) => utxo.token)).toEqual([
      { category, amount: 5n, nft: minting },
    ]);
    expect(await bob.getTokenUtxos(category)).toHaveLength(1);
  });
});
