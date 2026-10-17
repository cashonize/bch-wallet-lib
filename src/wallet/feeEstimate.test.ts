import { binToHex, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { Config } from "../config.js";
import { NFTCapability, Utxo } from "../interface.js";
import { getRelayFeeCache } from "../network/getRelayFeeCache.js";
import {
  feeAbsolute,
  feeFixedPerByte,
  FeeFn,
} from "../transaction/coin-control/index.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import {
  SendRequest,
  TokenBurnRequest,
  TokenMintRequest,
  TokenSendRequest,
} from "./model.js";
import { FeePaidByEnum } from "./enum.js";
import { InsufficientFundsError } from "./errors.js";
import { RegTestWallet } from "./Wif.js";

const decode = (transactionHex: string) => {
  const tx = decodeTransaction(hexToBin(transactionHex));
  if (typeof tx === "string") throw new Error(tx);
  return tx;
};

const inputOutpoints = (transactionHex: string) =>
  decode(transactionHex)
    .inputs.map(
      (input) =>
        `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
    )
    .sort();

const outpointsOf = (coins: Utxo[]) =>
  coins.map((coin) => `${coin.txid}:${coin.vout}`).sort();

// What the transaction pays in fees, from the wallet's coins it spends, next to what its size at
// the relay fee rate asks for (getFeeAmount's rounding)
const feeCheck = async (
  wallet: RegTestWallet,
  transactionHex: string,
  coins: Utxo[],
) => {
  const tx = decode(transactionHex);
  const spent = inputOutpoints(transactionHex);
  const inputValue = coins
    .filter((coin) => spent.includes(`${coin.txid}:${coin.vout}`))
    .reduce((sum, coin) => sum + coin.satoshis, 0n);
  const outputValue = tx.outputs.reduce(
    (sum, output) => sum + output.valueSatoshis,
    0n,
  );
  const rate = await getRelayFeeCache(wallet.provider);
  return {
    paid: inputValue - outputValue,
    expected: BigInt(Math.ceil((transactionHex.length / 2) * rate + 1)),
  };
};

// A new wallet holding `count` coins of `value` sats, and the funding wallet
const fund = async (count: number, value: bigint) => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const bob = await RegTestWallet.newRandom();
  await alice.send(
    Array.from(
      { length: count },
      () => new SendRequest({ cashaddr: bob.cashaddr!, value }),
    ),
  );
  return { alice, bob, coins: await bob.getUtxos() };
};

const outputValues = (transactionHex: string) =>
  decode(transactionHex).outputs.map((output) => output.valueSatoshis);

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe("fee estimated from the selected coins (mainnet-js#253)", () => {
  test("a send from a wallet with many coins spends only the coins it needs", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send(
      Array.from(
        { length: 100 },
        () => new SendRequest({ cashaddr: bob.cashaddr!, value: 1000n }),
      ),
    );
    const coins = await bob.getUtxos();
    expect(coins.length).toBe(100);

    // 4500 sats and the fee of six inputs take six coins; sizing all 100 coins took 20
    const response = await bob.send(
      new SendRequest({ cashaddr: alice.cashaddr!, value: 4500n }),
    );
    const tx = decode(response.transaction);
    expect(tx.inputs.length).toBe(6);
    const { paid, expected } = await feeCheck(bob, response.transaction, coins);
    expect(paid).toBe(expected);
    expect(tx.outputs.map((output) => output.valueSatoshis)).toEqual([
      4500n,
      6000n - 4500n - expected,
    ]);
  });

  test("token operations in a wallet with many token coins and little BCH", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    // 100 NFTs and 50 fungible coins of two other categories, 1000 sats each
    const nftGenesis = await alice.tokenGenesis({
      nft: { capability: NFTCapability.minting, commitment: "" },
    });
    const nftCategory = nftGenesis.categories[0];
    await alice.tokenMint(
      Array.from(
        { length: 100 },
        (_, i) =>
          new TokenMintRequest({
            category: nftCategory,
            cashaddr: bob.tokenaddr!,
            nft: {
              capability: NFTCapability.none,
              commitment: i.toString(16).padStart(2, "0"),
            },
          }),
      ),
    );
    const ftGenesis = await alice.tokenGenesis({ amount: 50n });
    const ftCategory = ftGenesis.categories[0];
    await alice.send(
      Array.from(
        { length: 50 },
        () =>
          new TokenSendRequest({
            cashaddr: bob.tokenaddr!,
            category: ftCategory,
            amount: 1n,
          }),
      ),
    );
    // the only BCH coin, at vout 0 for the genesis; sizing every token coin asked for over 29000 sats
    await alice.send(
      new SendRequest({ cashaddr: bob.cashaddr!, value: 5000n }),
    );
    const tokenCoins = await bob.getTokenUtxos();
    expect(tokenCoins.length).toBe(150);

    const bchCoins = async () =>
      (await bob.getUtxos()).filter((coin) => !coin.token);
    const expectSpent = async (
      transactionHex: string,
      coinsBefore: Utxo[],
      spent: Utxo[],
    ) => {
      expect(inputOutpoints(transactionHex)).toEqual(outpointsOf(spent));
      const { paid, expected } = await feeCheck(
        bob,
        transactionHex,
        coinsBefore,
      );
      expect(paid).toBe(expected);
    };

    let coins = await bob.getUtxos();
    let funding = await bchCoins();
    const genesis = await bob.tokenGenesis({
      amount: 10n,
      nft: { capability: NFTCapability.minting, commitment: "" },
    });
    await expectSpent(genesis.transaction, coins, funding);
    const ownCategory = genesis.categories[0];

    // the burned NFT's own sats pay its fee, no BCH coin is added
    coins = await bob.getUtxos();
    const nft = tokenCoins.find(
      (coin) => coin.token!.nft?.commitment === "00",
    )!;
    const burn = await bob.tokenBurn(
      new TokenBurnRequest({
        category: nftCategory,
        nft: { capability: NFTCapability.none, commitment: "00" },
      }),
    );
    await expectSpent(burn.transaction, coins, [nft]);

    coins = await bob.getUtxos();
    funding = await bchCoins();
    const minting = (await bob.getTokenUtxos(ownCategory))[0];
    const mint = await bob.tokenMint(
      new TokenMintRequest({
        category: ownCategory,
        nft: { capability: NFTCapability.none, commitment: "01" },
      }),
    );
    await expectSpent(mint.transaction, coins, [minting, ...funding]);

    coins = await bob.getUtxos();
    funding = await bchCoins();
    const sent = tokenCoins.find(
      (coin) => coin.token!.nft?.commitment === "01",
    )!;
    const send = await bob.send(
      new TokenSendRequest({
        cashaddr: alice.tokenaddr!,
        category: nftCategory,
        nft: { capability: NFTCapability.none, commitment: "01" },
      }),
    );
    await expectSpent(send.transaction, coins, [sent, ...funding]);

    // sendMax spends every BCH coin and no token coin, the amount getMaxAmountToSend gives
    funding = await bchCoins();
    const max = await bob.getMaxAmountToSend();
    const sendMax = await bob.sendMax(alice.cashaddr!);
    expect(inputOutpoints(sendMax.transaction)).toEqual(outpointsOf(funding));
    expect(
      decode(sendMax.transaction).outputs.map((output) => output.valueSatoshis),
    ).toEqual([max]);
    expect((await bob.getTokenUtxos()).length).toBe(150);
  });

  test("a change at or below dust is topped up when another input costs less than it", async () => {
    const { alice, bob, coins } = await fund(20, 1000n);
    // 11 coins cover 9000 sats and their fee and leave 404 sats, which would go to the miners;
    // a 12th coin costs 141 sats and brings the change back above dust
    const response = await bob.send(
      new SendRequest({ cashaddr: alice.cashaddr!, value: 9000n }),
    );
    expect(decode(response.transaction).inputs.length).toBe(12);
    const { paid, expected } = await feeCheck(bob, response.transaction, coins);
    expect(paid).toBe(expected);
    expect(outputValues(response.transaction)).toEqual([
      9000n,
      12000n - 9000n - expected,
    ]);
  });

  test("a change at or below dust is left to the miners when another input costs more", async () => {
    const { alice, bob, coins } = await fund(10, 1000n);
    // six coins leave 125 sats, less than the 141 sats a seventh input costs
    const response = await bob.send(
      new SendRequest({ cashaddr: alice.cashaddr!, value: 4950n }),
    );
    expect(decode(response.transaction).inputs.length).toBe(6);
    expect(outputValues(response.transaction)).toEqual([4950n]);
    const { paid } = await feeCheck(bob, response.transaction, coins);
    expect(paid).toBe(6000n - 4950n);
  });

  test("a fee strategy above the relay rate is funded by the selection", async () => {
    const { alice, bob, coins } = await fund(10, 1000n);
    const send = (fee: FeeFn) =>
      bob.send(new SendRequest({ cashaddr: alice.cashaddr!, value: 3000n }), {
        fee,
        broadcast: false,
      });
    const paidOf = async (transactionHex: string) =>
      (await feeCheck(bob, transactionHex, coins)).paid;

    // four coins cover the relay-rate estimate, but at 2 sat/byte their 608 bytes ask for 1216
    // sats; a check against the estimate alone built them paying 1000
    const perByte = await send(feeFixedPerByte(2));
    const perByteSize = perByte.transaction.length / 2;
    expect(decode(perByte.transaction).inputs.length).toBe(6);
    expect(await paidOf(perByte.transaction)).toBe(BigInt(perByteSize * 2));
    expect(outputValues(perByte.transaction)).toEqual([
      3000n,
      6000n - 3000n - BigInt(perByteSize * 2),
    ]);

    const absolute = await send(feeAbsolute(4000n));
    expect(decode(absolute.transaction).inputs.length).toBe(8);
    expect(await paidOf(absolute.transaction)).toBe(4000n);
    expect(outputValues(absolute.transaction)).toEqual([3000n, 1000n]);
  });

  test("sendMax spends every coin, also those worth less than their input fee", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send([
      new SendRequest({ cashaddr: bob.cashaddr!, value: 20000n }),
      ...Array.from(
        { length: 20 },
        () => new SendRequest({ cashaddr: bob.cashaddr!, value: 600n }),
      ),
    ]);
    const coins = await bob.getUtxos();
    // at 5 sat/byte a 600 sat coin costs more than it holds; the 20000 sat coin alone covers the
    // amount, and spending only it paid 3960 sats for 185 bytes and kept the small coins
    const relayFeePerByte = Config.RelayFeePerByte;
    Config.RelayFeePerByte = 5;
    try {
      const max = await bob.getMaxAmountToSend();
      const response = await bob.sendMax(alice.cashaddr!, { broadcast: false });
      expect(inputOutpoints(response.transaction)).toEqual(outpointsOf(coins));
      expect(outputValues(response.transaction)).toEqual([max]);
    } finally {
      Config.RelayFeePerByte = relayFeePerByte;
    }
  });

  test("a shortfall reports the fee of spending every coin the send could use", async () => {
    const { alice, bob } = await fund(5, 1000n);
    // 5000 sats and the fee of five inputs and two outputs at the simple estimate; the fee of
    // the last round's selection alone was the 84 sats of no inputs
    const error = await bob
      .send(new SendRequest({ cashaddr: alice.cashaddr!, value: 5000n }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(InsufficientFundsError);
    expect(error.message).toBe(
      "Amount required was not met, 5824 satoshis needed, 5000 satoshis available",
    );
    expect(error.data).toEqual({ required: 5824n, available: 5000n });
  });

  test("an output that pays the fee is not charged it a second time on the change", async () => {
    const { alice, bob, coins } = await fund(10, 1000n);
    const send = (value: bigint, feePaidBy: FeePaidByEnum, utxoIds?: Utxo[]) =>
      bob.send(new SendRequest({ cashaddr: alice.cashaddr!, value }), {
        feePaidBy,
        utxoIds,
        broadcast: false,
      });

    // the change took the fee off as well, leaving 75 sats that went to the miners
    const first = await send(5000n, FeePaidByEnum.first);
    expect(decode(first.transaction).inputs.length).toBe(6);
    const { paid, expected } = await feeCheck(bob, first.transaction, coins);
    expect(paid).toBe(expected);
    expect(outputValues(first.transaction)).toEqual([5000n - expected, 1000n]);

    // the 500 sats of change pay part of the fee and the output the rest; the output paid the
    // whole fee and the 391 sats the change fell short by again
    const changeThenFirst = await send(
      5500n,
      FeePaidByEnum.changeThenFirst,
      coins.slice(0, 6),
    );
    const changeThenFirstFee = await feeCheck(
      bob,
      changeThenFirst.transaction,
      coins,
    );
    expect(changeThenFirstFee.paid).toBe(changeThenFirstFee.expected);
    expect(outputValues(changeThenFirst.transaction)).toEqual([
      6000n - changeThenFirstFee.expected,
    ]);
  });
});

describe("an output that pays the fee is checked as the change is", () => {
  const send = (
    bob: RegTestWallet,
    requests: Array<SendRequest | TokenSendRequest>,
    feePaidBy: FeePaidByEnum,
    utxoIds?: Utxo[],
  ) => bob.send(requests, { feePaidBy, utxoIds, broadcast: false });

  test("outputs the coins cannot cover are refused, the fee paid by an output or not", async () => {
    const { alice, bob } = await fund(5, 1000n);
    const request = new SendRequest({
      cashaddr: alice.cashaddr!,
      value: 5200n,
    });
    // the outputs alone took 200 sats more than the inputs held, which the network refuses;
    // with the change first, the output paid those 200 sats on top of the fee
    for (const feePaidBy of [
      FeePaidByEnum.first,
      FeePaidByEnum.last,
      FeePaidByEnum.any,
      FeePaidByEnum.changeThenFirst,
      FeePaidByEnum.changeThenLast,
      FeePaidByEnum.changeThenAny,
    ]) {
      const error = await send(bob, [request], feePaidBy).catch((e) => e);
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect(error.asset).toBe("bch");
      expect(error.data).toEqual({ required: 5200n, available: 5000n });
    }
  });

  test("an output the fee would take below dust is refused", async () => {
    const { alice, bob } = await fund(5, 1000n);
    // three inputs cost more than the 300 sats the output holds above dust
    for (const feePaidBy of [FeePaidByEnum.first, FeePaidByEnum.last]) {
      const error = await send(
        bob,
        [new SendRequest({ cashaddr: alice.cashaddr!, value: 846n })],
        feePaidBy,
        (await bob.getUtxos()).slice(0, 3),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect(error.asset).toBe("bch");
    }
  });

  test("a send of no outputs is refused, though a token change of ensureUtxos is one", async () => {
    const { bob } = await fund(1, 20000n);
    const genesis = await bob.tokenGenesis({ amount: 10n });
    const tokenCoins = await bob.getTokenUtxos(genesis.categories[0]);
    await expect(bob.send([], { broadcast: false })).rejects.toThrow(
      "Attempted to specify feePaidBy on zero length SendRequest",
    );
    const response = await bob.send([], {
      ensureUtxos: tokenCoins,
      broadcast: false,
    });
    expect(
      decode(response.transaction).outputs.map(
        (output) => output.token?.amount,
      ),
    ).toEqual([10n, undefined]);
  });

  test("the last requested output pays the fee, not the token change after it", async () => {
    const { alice, bob } = await fund(1, 20000n);
    const genesis = await bob.tokenGenesis({ amount: 10n });
    const category = genesis.categories[0];
    const coins = await bob.getUtxos();

    // the token change came last and was asked to pay: "Cannot specify fee to be paid by
    // TokenSendRequest"
    const response = await send(
      bob,
      [
        new TokenSendRequest({
          cashaddr: alice.tokenaddr!,
          category,
          amount: 4n,
        }),
        new SendRequest({ cashaddr: alice.cashaddr!, value: 5000n }),
      ],
      FeePaidByEnum.last,
    );
    const { paid, expected } = await feeCheck(bob, response.transaction, coins);
    expect(paid).toBe(expected);
    const inputValue = coins.reduce((sum, coin) => sum + coin.satoshis, 0n);
    expect(decode(response.transaction).inputs.length).toBe(coins.length);
    const outputs = decode(response.transaction).outputs.map((output) => ({
      value: output.valueSatoshis,
      amount: output.token?.amount,
    }));
    expect(outputs).toEqual([
      { value: 1000n, amount: 4n },
      { value: 5000n - expected, amount: undefined },
      { value: 1000n, amount: 6n },
      { value: inputValue - 7000n, amount: undefined },
    ]);
  });
});

describe("sendMax takes the fee options send takes", () => {
  test("a fee strategy prices the max and the transaction", async () => {
    const { alice, bob, coins } = await fund(5, 1000n);
    const sendMax = (options: { fee: FeeFn }) =>
      bob.sendMax(alice.cashaddr!, { ...options, broadcast: false });
    const maxOf = (options: { fee: FeeFn }) =>
      bob.getMaxAmountToSend({ outputCount: 1, options });

    // the max was priced at the relay rate, and sendMax threw "Amount required was not met"
    const absolute = { fee: feeAbsolute(1500n) };
    expect(await maxOf(absolute)).toBe(3500n);
    const absoluteSend = await sendMax(absolute);
    expect(inputOutpoints(absoluteSend.transaction)).toEqual(
      outpointsOf(coins),
    );
    expect(outputValues(absoluteSend.transaction)).toEqual([3500n]);

    const perByte = { fee: feeFixedPerByte(3) };
    const perByteMax = await maxOf(perByte);
    const perByteSend = await sendMax(perByte);
    expect(outputValues(perByteSend.transaction)).toEqual([perByteMax]);
    expect(5000n - perByteMax).toBeGreaterThanOrEqual(
      BigInt((perByteSend.transaction.length / 2) * 3),
    );

    // below the relay rate, which the selection's relay-rate estimate could not fit in the coins
    const low = { fee: feeAbsolute(200n) };
    expect(await maxOf(low)).toBe(4800n);
    expect(outputValues((await sendMax(low)).transaction)).toEqual([4800n]);
  });
});
