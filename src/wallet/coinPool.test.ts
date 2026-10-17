import { binToHex, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { NFTCapability, Utxo } from "../interface.js";
import {
  InsufficientFundsError,
  InvalidRequestError,
  UtxoNotAvailableError,
} from "./errors.js";
import {
  SendRequest,
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

const outpoint = (utxo: Utxo) => `${utxo.txid}:${utxo.vout}`;

const decoded = (transactionHex: string) => {
  const tx = decodeTransaction(hexToBin(transactionHex));
  if (typeof tx === "string") throw new Error(tx);
  return tx;
};

const inputOutpoints = (transactionHex: string) =>
  decoded(transactionHex)
    .inputs.map(
      (input) =>
        `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
    )
    .sort();

// a wallet funded with one coin per value, each at vout 0 of its own transaction
const fundedWallet = async (...values: bigint[]) => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const bob = await RegTestWallet.newRandom();
  for (const value of values) {
    await alice.send({ cashaddr: bob.cashaddr!, value });
  }
  return bob;
};

const notAvailable = async (spend: Promise<unknown>) => {
  const error = await spend.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UtxoNotAvailableError);
  return error as UtxoNotAvailableError;
};

describe("excludeUtxoIds keeps coins out of every spend", () => {
  test("send leaves out the coin it would otherwise spend", async () => {
    const bob = await fundedWallet(10_000n, 20_000n, 30_000n);
    const carol = await RegTestWallet.newRandom();
    const request = new SendRequest({
      cashaddr: carol.cashaddr!,
      value: 5000n,
    });

    const plain = await bob.send(request, { broadcast: false });
    const [spent] = inputOutpoints(plain.transaction!);

    const response = await bob.send(request, {
      broadcast: false,
      excludeUtxoIds: [spent],
    });
    expect(inputOutpoints(response.transaction!)).not.toContain(spent);
  });

  test("a send the remaining coins cannot cover falls short", async () => {
    const bob = await fundedWallet(10_000n, 20_000n);
    const carol = await RegTestWallet.newRandom();
    const big = (await bob.getUtxos()).find(
      (utxo) => utxo.satoshis === 20_000n,
    )!;

    const error = await bob
      .send(new SendRequest({ cashaddr: carol.cashaddr!, value: 15_000n }), {
        broadcast: false,
        excludeUtxoIds: [big],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientFundsError);
  });

  test("sendMax and getMaxAmountToSend count only the coins not excluded", async () => {
    const bob = await fundedWallet(10_000n, 20_000n, 30_000n);
    const carol = await RegTestWallet.newRandom();
    const coins = await bob.getUtxos();
    const reserved = coins.find((utxo) => utxo.satoshis === 20_000n)!;
    const options = { excludeUtxoIds: [outpoint(reserved)] };

    const max = await bob.getMaxAmountToSend(options);
    expect(max).toBeLessThan(40_000n);
    expect(max).toBeGreaterThan(39_000n);

    const response = await bob.sendMax(carol.cashaddr!, {
      ...options,
      broadcast: false,
    });
    expect(inputOutpoints(response.transaction!)).toEqual(
      coins
        .filter((utxo) => utxo !== reserved)
        .map(outpoint)
        .sort(),
    );
    const outputs = decoded(response.transaction!).outputs;
    expect(outputs.map((output) => output.valueSatoshis)).toEqual([max]);
  });

  test("an id in another case still excludes its coin", async () => {
    const bob = await fundedWallet(10_000n);
    const [coin] = await bob.getUtxos();
    const request = new SendRequest({ cashaddr: bob.cashaddr!, value: 1000n });

    for (const excludeUtxoIds of [
      [`${coin.txid.toUpperCase()}:${coin.vout}`],
      [{ ...coin, txid: coin.txid.toUpperCase() }],
    ]) {
      const error = await bob
        .send(request, { broadcast: false, excludeUtxoIds })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InsufficientFundsError);
    }
  });

  test("an id that is not an outpoint is refused, not ignored", async () => {
    const bob = await fundedWallet(10_000n);
    const [coin] = await bob.getUtxos();
    const request = new SendRequest({ cashaddr: bob.cashaddr!, value: 1000n });

    for (const id of [
      coin.txid,
      `${coin.txid}:`,
      `${coin.txid}:0x`,
      `${coin.txid}:-1`,
      `${coin.txid.slice(1)}:0`,
      `${coin.txid}z:0`,
    ]) {
      const error = await bob
        .send(request, { broadcast: false, excludeUtxoIds: [id] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as InvalidRequestError).field).toBe("excludeUtxoIds");
      expect((error as InvalidRequestError).value).toBe(id);
    }
    const noVout = { ...coin, vout: Number.NaN };
    const error = await bob
      .sendMax(bob.cashaddr!, { broadcast: false, excludeUtxoIds: [noVout] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);

    // a well-formed id of a coin the wallet does not hold is a reservation that outlived it
    const response = await bob.send(request, {
      broadcast: false,
      excludeUtxoIds: [`${"ab".repeat(32)}:0`, `${coin.txid}:5`],
    });
    expect(inputOutpoints(response.transaction!)).toEqual([outpoint(coin)]);
  });

  test("excludeUtxoIds narrows utxoIds further", async () => {
    const bob = await fundedWallet(10_000n, 20_000n, 30_000n);
    const carol = await RegTestWallet.newRandom();
    const coins = await bob.getUtxos();
    const [first, second] = coins;

    const response = await bob.sendMax(carol.cashaddr!, {
      broadcast: false,
      utxoIds: [first, second],
      excludeUtxoIds: [outpoint(second)],
    });
    expect(inputOutpoints(response.transaction!)).toEqual([outpoint(first)]);
    expect(
      await bob.getMaxAmountToSend({
        utxoIds: [first, second],
        excludeUtxoIds: [second],
      }),
    ).toBe(decoded(response.transaction!).outputs[0].valueSatoshis);
  });

  test("a fungible send leaves out a reserved hybrid coin", async () => {
    const bob = await fundedWallet(100_000n);
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const genesis = await bob.tokenGenesis({ amount: 100n, nft: minting });
    const category = genesis.categories![0];
    // split off a fungible-only coin of 50, the minting coin keeps the other 50
    await bob.send(
      new TokenSendRequest({ cashaddr: bob.tokenaddr!, amount: 50n, category }),
    );
    const tokenCoins = await bob.getTokenUtxos(category);
    const hybrid = tokenCoins.find((utxo) => utxo.token?.nft)!;
    const fungible = tokenCoins.find((utxo) => !utxo.token?.nft)!;
    const carol = await RegTestWallet.newRandom();

    // 60 needs the hybrid coin's tokens as well as the fungible-only coin's
    const plain = await bob.send(
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        amount: 60n,
        category,
      }),
      { broadcast: false },
    );
    expect(inputOutpoints(plain.transaction!)).toContain(outpoint(hybrid));

    const error = await bob
      .send(
        new TokenSendRequest({
          cashaddr: carol.tokenaddr!,
          amount: 60n,
          category,
        }),
        { broadcast: false, excludeUtxoIds: [hybrid] },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientFundsError);

    // with the fungible-only coin reserved, the hybrid coin covers 30
    const response = await bob.send(
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        amount: 30n,
        category,
      }),
      { broadcast: false, excludeUtxoIds: [fungible] },
    );
    const spent = inputOutpoints(response.transaction!);
    expect(spent).toContain(outpoint(hybrid));
    expect(spent).not.toContain(outpoint(fungible));
  });

  test("an NFT request takes another coin with the same NFT than the reserved one", async () => {
    const bob = await fundedWallet(100_000n);
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const genesis = await bob.tokenGenesis({ nft: minting });
    const category = genesis.categories![0];
    const nft = { capability: NFTCapability.none, commitment: "aa" };
    await bob.tokenMint([
      new TokenMintRequest({ category, nft }),
      new TokenMintRequest({ category, nft }),
    ]);
    const request = new TokenSendRequest({
      cashaddr: (await RegTestWallet.newRandom()).tokenaddr!,
      category,
      nft,
    });

    const plain = await bob.send(request, { broadcast: false });
    const copies = (await bob.getTokenUtxos(category))
      .filter((utxo) => utxo.token?.nft?.commitment === "aa")
      .map(outpoint);
    expect(copies).toHaveLength(2);
    const [picked] = inputOutpoints(plain.transaction!).filter((id) =>
      copies.includes(id),
    );

    const response = await bob.send(request, {
      broadcast: false,
      excludeUtxoIds: [picked],
    });
    const spent = inputOutpoints(response.transaction!);
    expect(spent).not.toContain(picked);
    expect(spent).toContain(copies.find((id) => id !== picked));
  });

  test("tokenGenesis takes another vout-0 coin than the reserved one", async () => {
    const bob = await fundedWallet(10_000n, 20_000n);
    const plain = await bob.tokenGenesis({ amount: 1n }, [], {
      broadcast: false,
    });
    const first = plain.categories![0];

    const response = await bob.tokenGenesis({ amount: 1n }, [], {
      broadcast: false,
      excludeUtxoIds: [`${first}:0`],
    });
    expect(response.categories![0]).not.toBe(first);
    expect(inputOutpoints(response.transaction!)).not.toContain(`${first}:0`);
  });

  test("tokenMint spends another minting NFT than the reserved one", async () => {
    const bob = await fundedWallet(100_000n);
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const genesis = await bob.tokenGenesis({ nft: minting });
    const category = genesis.categories![0];
    // a second minting NFT of the category
    await bob.tokenMint(new TokenMintRequest({ category, nft: minting }));
    const mintingCoins = (await bob.getTokenUtxos(category)).map(outpoint);
    expect(mintingCoins).toHaveLength(2);
    const request = new TokenMintRequest({
      category,
      nft: { capability: NFTCapability.none, commitment: "01" },
    });

    const plain = await bob.tokenMint(request, { broadcast: false });
    const [picked] = inputOutpoints(plain.transaction!).filter((id) =>
      mintingCoins.includes(id),
    );

    const response = await bob.tokenMint(request, {
      broadcast: false,
      excludeUtxoIds: [picked],
    });
    const spent = inputOutpoints(response.transaction!);
    expect(spent).not.toContain(picked);
    expect(spent).toContain(mintingCoins.find((id) => id !== picked));

    const error = await bob
      .tokenMint(request, {
        broadcast: false,
        excludeUtxoIds: mintingCoins,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientFundsError);
  });

  test("tokenBurn burns another coin than the reserved one", async () => {
    const bob = await fundedWallet(100_000n);
    const genesis = await bob.tokenGenesis({ amount: 100n });
    const category = genesis.categories![0];
    await bob.send(
      new TokenSendRequest({ cashaddr: bob.tokenaddr!, amount: 40n, category }),
    );
    const tokenCoins = await bob.getTokenUtxos(category);
    expect(tokenCoins).toHaveLength(2);
    const request = new TokenBurnRequest({ category, amount: 10n });

    const plain = await bob.tokenBurn(request, undefined, { broadcast: false });
    const [picked] = inputOutpoints(plain.transaction!).filter((id) =>
      tokenCoins.map(outpoint).includes(id),
    );

    const response = await bob.tokenBurn(request, undefined, {
      broadcast: false,
      excludeUtxoIds: [picked],
    });
    const spent = inputOutpoints(response.transaction!);
    expect(spent).not.toContain(picked);
    expect(spent).toContain(
      tokenCoins.map(outpoint).find((id) => id !== picked),
    );
  });
});

describe("the pool is a set", () => {
  test("a coin listed twice in utxoIds counts once", async () => {
    const bob = await fundedWallet(100_000n);
    const genesis = await bob.tokenGenesis({ amount: 100n, value: 5000n });
    const category = genesis.categories![0];
    const [tokenCoin] = await bob.getTokenUtxos(category);
    const coins = await bob.getUtxos();
    const request = new TokenBurnRequest({ category, amount: 10n });
    const outputValues = (transactionHex: string) =>
      decoded(transactionHex).outputs.map((output) => output.valueSatoshis);

    const plain = await bob.tokenBurn(request, "", {
      broadcast: false,
      utxoIds: coins,
    });
    const twice = await bob.tokenBurn(request, "", {
      broadcast: false,
      utxoIds: [...coins, tokenCoin],
    });
    expect(outputValues(twice.transaction!)).toEqual(
      outputValues(plain.transaction!),
    );
    expect(inputOutpoints(twice.transaction!)).toEqual(
      inputOutpoints(plain.transaction!),
    );
  });
});

describe("ensureUtxos must be in the pool", () => {
  test("an excluded coin", async () => {
    const bob = await fundedWallet(10_000n, 20_000n);
    const [coin] = await bob.getUtxos();
    const request = new SendRequest({ cashaddr: bob.cashaddr!, value: 1000n });

    const error = await notAvailable(
      bob.send(request, {
        broadcast: false,
        ensureUtxos: [coin],
        excludeUtxoIds: [outpoint(coin)],
      }),
    );
    expect(error.reason).toBe("excluded");
    expect(error.utxoId).toBe(outpoint(coin));

    // excluded wins over utxoIds
    const both = await notAvailable(
      bob.sendMax(bob.cashaddr!, {
        broadcast: false,
        utxoIds: [coin],
        ensureUtxos: [coin],
        excludeUtxoIds: [coin],
      }),
    );
    expect(both.reason).toBe("excluded");
  });

  test("a coin outside utxoIds", async () => {
    const bob = await fundedWallet(10_000n, 20_000n);
    const [first, second] = await bob.getUtxos();
    const request = new SendRequest({ cashaddr: bob.cashaddr!, value: 1000n });

    const error = await notAvailable(
      bob.send(request, {
        broadcast: false,
        utxoIds: [first],
        ensureUtxos: [second],
      }),
    );
    expect(error.reason).toBe("not-in-utxoIds");
    expect(error.utxoId).toBe(outpoint(second));
  });

  test("a coin the wallet does not hold", async () => {
    const bob = await fundedWallet(10_000n);
    const [coin] = await bob.getUtxos();
    const request = new SendRequest({ cashaddr: bob.cashaddr!, value: 1000n });

    const error = await notAvailable(
      bob.send(request, {
        broadcast: false,
        ensureUtxos: [{ ...coin, vout: 7 }],
      }),
    );
    expect(error.reason).toBe("not-found");
  });

  test("the token operations and the max amount refuse it too", async () => {
    const bob = await fundedWallet(100_000n, 10_000n);
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const genesis = await bob.tokenGenesis({ amount: 10n, nft: minting });
    const category = genesis.categories![0];
    const coin = (await bob.getUtxos()).find((utxo) => !utxo.token)!;
    const options = {
      broadcast: false,
      ensureUtxos: [coin],
      excludeUtxoIds: [coin],
    };

    for (const spend of [
      () => bob.tokenGenesis({ amount: 1n }, [], options),
      () =>
        bob.tokenMint(
          new TokenMintRequest({
            category,
            nft: { capability: NFTCapability.none, commitment: "" },
          }),
          options,
        ),
      () =>
        bob.tokenBurn(
          new TokenBurnRequest({ category, amount: 1n }),
          "",
          options,
        ),
      () => bob.getMaxAmountToSend(options),
    ]) {
      expect((await notAvailable(spend())).reason).toBe("excluded");
    }
  });

  test("a caller's copy of a pool coin counts as the wallet's coin", async () => {
    const bob = await fundedWallet(10_000n, 20_000n);
    const [coin] = await bob.getUtxos();
    // a stale or altered copy cannot fund more than the coin holds
    const copy = { ...coin, satoshis: 1_000_000n };

    const error = await bob
      .send(new SendRequest({ cashaddr: bob.cashaddr!, value: 500_000n }), {
        broadcast: false,
        ensureUtxos: [copy],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientFundsError);
  });
});

describe("sendMax spends only what it counts", () => {
  // what the inputs hold beyond the outputs: the fee, for a transaction of the wallet's own coins
  const feeOf = (transactionHex: string, coins: Utxo[]) => {
    const values = new Map(
      coins.map((utxo) => [outpoint(utxo), utxo.satoshis]),
    );
    const tx = decoded(transactionHex);
    const inputs = tx.inputs.reduce(
      (sum, input) =>
        sum +
        values.get(
          `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
        )!,
      0n,
    );
    return (
      inputs - tx.outputs.reduce((sum, out) => sum + out.valueSatoshis, 0n)
    );
  };

  test("a token coin in ensureUtxos is refused, its satoshis would go to the miners", async () => {
    const bob = await fundedWallet(100_000n);
    const genesis = await bob.tokenGenesis({ amount: 100n, value: 50_000n });
    const category = genesis.categories![0];
    const [tokenCoin] = await bob.getTokenUtxos(category);
    const carol = await RegTestWallet.newRandom();

    for (const spend of [
      () =>
        bob.sendMax(carol.cashaddr!, {
          broadcast: false,
          ensureUtxos: [tokenCoin],
        }),
      () => bob.getMaxAmountToSend({ ensureUtxos: [tokenCoin] }),
    ]) {
      const error = await spend().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as InvalidRequestError).field).toBe("ensureUtxos");
      expect((error as InvalidRequestError).value).toBe(outpoint(tokenCoin));
    }
  });

  test("a BCH coin in ensureUtxos goes first, and the fee stays at the relay rate", async () => {
    const bob = await fundedWallet(10_000n, 20_000n, 30_000n);
    const carol = await RegTestWallet.newRandom();
    const coins = await bob.getUtxos();
    const pinned = coins.find((utxo) => utxo.satoshis === 30_000n)!;
    const utxoIds = coins.filter((utxo) => utxo.satoshis !== 10_000n);

    const max = await bob.getMaxAmountToSend({
      utxoIds,
      ensureUtxos: [pinned],
    });
    const response = await bob.sendMax(carol.cashaddr!, {
      broadcast: false,
      utxoIds,
      ensureUtxos: [pinned],
    });
    const tx = decoded(response.transaction!);
    expect(
      `${binToHex(tx.inputs[0].outpointTransactionHash)}:${tx.inputs[0].outpointIndex}`,
    ).toBe(outpoint(pinned));
    expect(inputOutpoints(response.transaction!)).toEqual(
      utxoIds.map(outpoint).sort(),
    );
    expect(tx.outputs.map((output) => output.valueSatoshis)).toEqual([max]);
    const size = BigInt(response.transaction!.length / 2);
    const fee = feeOf(response.transaction!, coins);
    // sendMax's size estimate leaves a margin over the 1 sat/byte relay rate, as without ensureUtxos
    expect(fee).toBeGreaterThanOrEqual(size);
    expect(fee).toBeLessThan(2n * size);
  });
});
