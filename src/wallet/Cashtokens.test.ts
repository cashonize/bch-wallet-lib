import {
  binsAreEqual,
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransaction,
  hexToBin,
  utf8ToBin,
} from "@bitauth/libauth";
import { Config } from "../config.js";
import { NFTCapability, Utxo } from "../interface.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import json from "../test/json.test.js";
import { convert, delay } from "../util/index.js";
import {
  SendRequest,
  SendResponse,
  TokenBurnRequest,
  TokenMintRequest,
  TokenSendRequest,
} from "./model.js";
import { InsufficientFundsError } from "./errors.js";
import { RegTestWallet, TestNetWallet } from "./Wif.js";
import { liveTests } from "#test/live.js";

const inputOutpoints = (transactionHex: string) => {
  const tx = decodeTransaction(hexToBin(transactionHex));
  if (typeof tx === "string") throw new Error(tx);
  return tx.inputs
    .map(
      (input) =>
        `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
    )
    .sort();
};

// A built transaction's outputs, locking bytecode and token data as hex
const decodeOutputs = (transactionHex: string) => {
  const tx = decodeTransaction(hexToBin(transactionHex));
  if (typeof tx === "string") throw new Error(tx);
  return tx.outputs.map((output) => ({
    lockingBytecode: binToHex(output.lockingBytecode),
    value: output.valueSatoshis,
    token: output.token && {
      category: binToHex(output.token.category),
      amount: output.token.amount,
      nft: output.token.nft && {
        capability: output.token.nft.capability,
        commitment: binToHex(output.token.nft.commitment),
      },
    },
  }));
};

const lockingBytecodeOf = (address: string) => {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === "string") throw new Error(result);
  return binToHex(result.bytecode);
};

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe(`Test cashtokens`, () => {
  test.skipIf(!liveTests)("Test chipnet request", async () => {
    const wallet = await TestNetWallet.watchOnly(
      "bchtest:pzszr88euuuy87uarx9krcuh5psy4zzghsm2033xk4",
    );
    const utxos = await wallet.getTokenUtxos();
    expect(utxos[0].token?.category).toBeDefined();
  });

  test("Test token genesis and max amount to send", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send([
      [bob.cashaddr!, BigInt(await convert(0.101, "bch", "sat"))],
    ]);
    await bob.tokenGenesis({
      amount: 100n,
    });

    const maxAmountToSend = await bob.getMaxAmountToSend();
    await bob.send([[alice.cashaddr!, maxAmountToSend]]);
    expect(await bob.getBalance()).toBe(0n + 1000n);
  });

  test("Test tokens will not be burned when sending bch value", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const genesisResponse = await alice.tokenGenesis({
      amount: 100n,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    await alice.send([
      new SendRequest({
        cashaddr: bob.cashaddr!,
        value: 5000n,
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        amount: 25n,
        category: category,
      }),
    ]);
    expect(await bob.getTokenBalance(category)).toBe(25n);
    expect(await bob.getBalance()).toBe(5000n + 1000n);

    await bob.send(
      new SendRequest({
        cashaddr: alice.cashaddr!,
        value: 1000n,
      }),
    );
    expect(await bob.getTokenBalance(category)).toBe(25n);
    expect(await bob.getBalance()).toBe(3780n + 1000n);

    await bob.sendMax(alice.cashaddr!);
    expect(await bob.getTokenBalance(category)).toBe(25n);
    expect(await bob.getBalance()).toBe(0n + 1000n);
  });

  test("Test fungible cashtoken genesis and sending", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const genesisResponse = await alice.tokenGenesis({
      amount: 300n,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(300n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    await alice.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        amount: 25n,
        category: category,
      }),
      new TokenSendRequest({
        cashaddr: alice.cashaddr!,
        amount: 25n,
        category: category,
      }),
      new SendRequest({
        cashaddr: bob.cashaddr!,
        value: 20000n,
      }),
    ]);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(2);
    expect(await alice.getTokenBalance(category)).toBe(275n);
    expect(await bob.getTokenBalance(category)).toBe(25n);
    expect(await bob.getNftTokenBalance(category)).toBe(0);
    expect((await bob.getAllNftTokenBalances())[category] || 0).toBe(0);

    await alice.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        amount: 75n,
        category: category,
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        amount: 100n,
        category: category,
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        amount: 100n,
        category: category,
      }),
    ]);

    expect(await alice.getTokenBalance(category)).toBe(0n);
    expect(await bob.getTokenBalance(category)).toBe(300n);

    await bob.tokenBurn({
      category: category,
      amount: 99n,
    });

    expect(await alice.getTokenBalance(category)).toBe(0n);
    expect(await bob.getTokenBalance(category)).toBe(201n);

    await bob.tokenBurn({
      category: category,
      amount: 200n,
    });

    expect(await bob.getTokenBalance(category)).toBe(1n);

    await bob.tokenBurn({
      category: category,
      amount: 1n,
    });
    expect(await bob.getTokenBalance(category)).toBe(0n);
  });

  test("Test NFT cashtoken genesis and sending", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      nft: {
        capability: NFTCapability.mutable,
        commitment:
          "abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd",
      },
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(0n);
    const nftTokenBalance = await alice.getNftTokenBalance(category);
    expect(nftTokenBalance).toBe(1);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    const response = await alice.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: NFTCapability.mutable,
          commitment: "abcd",
        },
      }),
    ]);
    expect(await alice.getTokenBalance(category)).toBe(0n);
    expect(await alice.getNftTokenBalance(category)).toBe(0);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(0);

    expect(await bob.getTokenBalance(category)).toBe(0n);
    const bobTokenUtxos = await bob.getTokenUtxos(category);
    expect(bobTokenUtxos.length).toBe(1);
    expect(category).toEqual(response.categories![0]);
    expect(bobTokenUtxos[0].token?.nft?.commitment).toEqual("abcd");
  });

  test("Test immutable NFT cashtoken genesis and sending, error on mutation", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      nft: {
        capability: NFTCapability.none,
        commitment: "abcd",
      },
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(0n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    await expect(
      alice.send([
        new TokenSendRequest({
          cashaddr: alice.cashaddr!,
          category: category,
          nft: {
            capability: NFTCapability.none,
            commitment: "abcd02",
          },
        }),
      ]),
    ).rejects.toThrow("No suitable token utxos available to send token");
  });

  test("Test mutable NFT cashtoken genesis and mutation", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      nft: {
        capability: NFTCapability.mutable,
        commitment: "abcd",
      },
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(0n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    const response = await alice.send([
      new TokenSendRequest({
        cashaddr: alice.cashaddr!,
        category: category,
        nft: {
          capability: NFTCapability.mutable,
          commitment: "abcd02",
        },
      }),
    ]);
    expect(await alice.getTokenBalance(category)).toBe(0n);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(1);
    expect(category).toEqual(response.categories![0]);
    expect(newTokenUtxos[0].token?.nft?.commitment).toEqual("abcd02");
  });

  test("Test minting NFT cashtoken genesis and minting", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      nft: {
        capability: NFTCapability.minting,
        commitment: "abcd",
      },
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(0n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    const response = await alice.tokenMint([
      new TokenMintRequest({
        category: category,
        cashaddr: alice.cashaddr!,
        nft: {
          commitment: "74657374",
          capability: NFTCapability.none,
        },
      }),
      new TokenMintRequest({
        category: category,
        cashaddr: alice.cashaddr!,
        nft: {
          commitment: "7465737432",
          capability: NFTCapability.none,
        },
      }),
    ]);
    expect(await alice.getTokenBalance(category)).toBe(0n);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(3);
    expect(category).toEqual(response.categories![0]);
  });

  test("Test minting semifungible tokens and sending them", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      nft: {
        capability: NFTCapability.minting,
        commitment: "abcd",
      },
    });

    const category = genesisResponse.categories![0];

    // mint 2 NFTs, amount reducing
    const response = await alice.tokenMint([
      new TokenMintRequest({
        category: category,
        cashaddr: alice.cashaddr!,
        nft: {
          capability: NFTCapability.none,
          commitment: "0a",
        },
      }),
      new TokenMintRequest({
        category: category,
        cashaddr: alice.cashaddr!,
        nft: {
          capability: NFTCapability.none,
          commitment: "0a",
        },
      }),
    ]);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(3);
    expect(category).toEqual(response.categories![0]);

    const bob = await RegTestWallet.newRandom();
    await alice.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: NFTCapability.none,
          commitment: "0a",
        },
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: NFTCapability.none,
          commitment: "0a",
        },
      }),
    ]);

    expect((await alice.getTokenUtxos(category)).length).toBe(1);
    const bobTokenUtxos = await bob.getTokenUtxos(category);
    expect(bobTokenUtxos.length).toBe(2);
    expect(category).toEqual(response.categories![0]);
  });

  test("Test minting NFT and optionally burning FT cashtoken", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      amount: 4n,
      nft: {
        capability: NFTCapability.minting,
        commitment: "abcd",
      },
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(4n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);

    // mint 2 NFTs, amount reducing
    const response = await alice.tokenMint(
      [
        new TokenMintRequest({
          category: category,
          cashaddr: alice.cashaddr!,
          nft: {
            capability: NFTCapability.none,
            commitment: "0a",
          },
        }),
        new TokenMintRequest({
          category: category,
          cashaddr: alice.cashaddr!,
          nft: {
            capability: NFTCapability.none,
            commitment: "0b",
          },
        }),
      ],
      true,
    );
    expect(await alice.getTokenBalance(category)).toBe(2n);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(3);
    expect(category).toEqual(response.categories![0]);

    // mint 2 more NFTs without amount reducing
    const ftResponse = await alice.tokenMint(
      [
        new TokenMintRequest({
          category: category,
          cashaddr: alice.cashaddr!,
          nft: {
            capability: NFTCapability.none,
            commitment: "0c",
          },
        }),
        new TokenMintRequest({
          category: category,
          cashaddr: alice.cashaddr!,
          nft: {
            capability: NFTCapability.none,
            commitment: "0d",
          },
        }),
      ],
      false,
    );
    expect(await alice.getTokenBalance(category)).toBe(2n);
    const ftTokenUtxos = await alice.getTokenUtxos(category);
    expect(ftTokenUtxos.length).toBe(5);
    expect(category).toEqual(ftResponse.categories![0]);

    // we are going to hit amount -1, when minting 3 more NFTs
    // check that it will stop at 0
    const ft2Response = await alice.tokenMint(
      [
        new TokenMintRequest({
          category: category,
          cashaddr: alice.cashaddr!,
          nft: {
            capability: NFTCapability.none,
            commitment: "0a",
          },
        }),
        new TokenMintRequest({
          category: category,
          cashaddr: alice.cashaddr!,
          nft: {
            capability: NFTCapability.none,
            commitment: "0a",
          },
        }),
        new TokenMintRequest({
          category: category,
          cashaddr: alice.cashaddr!,
          nft: {
            capability: NFTCapability.none,
            commitment: "0a",
          },
        }),
      ],
      true,
    );
    expect(await alice.getTokenBalance(category)).toBe(0n);
    const ft2TokenUtxos = await alice.getTokenUtxos(category);
    expect(ft2TokenUtxos.length).toBe(8);
    expect(category).toEqual(ft2Response.categories![0]);
  });

  test("Test explicit burning of FT", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      amount: 4n,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(4n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);

    // burn 5 FT
    const response = await alice.tokenBurn(
      {
        category: category,
        amount: 5n,
      },
      "burn",
    );

    const rawTx = await alice.provider!.getRawTransactionObject(response.txId!);
    expect(rawTx!.vout.length).toEqual(3);
    expect(rawTx!.vout[0].scriptPubKey.type).toEqual("nulldata");
    expect(rawTx!.vout[0].scriptPubKey.hex).toContain(
      binToHex(utf8ToBin("burn")),
    );
    expect(await alice.getTokenBalance(category)).toBe(0n);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(0);
    expect(category).toEqual(response.categories![0]);
  });

  test("Test explicit burning of FT and NFT", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      amount: 4n,
      nft: {
        capability: NFTCapability.minting,
        commitment: "abcd",
      },
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(4n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);

    // burn 1 FT
    const response = await alice.tokenBurn(
      {
        category: category,
        amount: 1n,
        nft: {
          capability: NFTCapability.minting,
          commitment: "abcd",
        },
      },
      "burn",
    );

    const rawTx = await alice.provider!.getRawTransactionObject(response.txId!);
    expect(rawTx!.vout.length).toEqual(3);
    expect(rawTx!.vout[0].scriptPubKey.type).toEqual("nulldata");
    expect(rawTx!.vout[0].scriptPubKey.hex).toContain(
      binToHex(utf8ToBin("burn")),
    );
    expect(await alice.getTokenBalance(category)).toBe(3n);
    expect((await alice.getAllTokenBalances())[category]).toBe(3n);
    const newTokenUtxos = await alice.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(1);
    expect(await alice.getNftTokenBalance(category)).toBe(1);
    expect((await alice.getAllNftTokenBalances())[category || 0]).toBe(1);
    expect(category).toEqual(response.categories![0]);

    // burn the rest FTs
    const ftResponse = await alice.tokenBurn(
      {
        category: category,
        amount: 5n,
        nft: {
          capability: NFTCapability.minting,
          commitment: "abcd",
        },
      },
      "burn",
    );
    expect(await alice.getTokenBalance(category)).toBe(0n);
    const ftTokenUtxos = await alice.getTokenUtxos(category);
    expect(ftTokenUtxos.length).toBe(1);
    expect(category).toEqual(ftResponse.categories![0]);

    // burn the NFT too
    const nftResponse = await alice.tokenBurn(
      {
        category: category,
        nft: {
          capability: NFTCapability.minting,
          commitment: "abcd",
        },
      },
      "burn",
    );
    expect(await alice.getTokenBalance(category)).toBe(0n);
    expect((await alice.getAllTokenBalances())[category] || 0n).toBe(0n);
    const nftTokenUtxos = await alice.getTokenUtxos(category);
    expect(nftTokenUtxos.length).toBe(0);
    expect(category).toEqual(nftResponse.categories![0]);
    expect(await alice.getNftTokenBalance(category)).toBe(0);
    expect((await alice.getAllNftTokenBalances())[category] || 0).toBe(0);
  });

  test("Test cashtoken satoshi values and fee calculations", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const genesisResponse = await alice.tokenGenesis({
      amount: 100n,
      value: 7000n,
      cashaddr: bob.cashaddr!,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await bob.getTokenBalance(category);
    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await bob.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    expect(tokenUtxos[0].satoshis).toBe(7000n);

    // lower the token satoshi value
    await bob.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        amount: 100n,
        category: category,
        value: 1500n,
      }),
    ]);
    let newTokenUtxos = await bob.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(1);
    expect(await bob.getTokenBalance(category)).toBe(100n);

    let bobUtxos = await bob.getUtxos();
    expect(bobUtxos.length).toBe(2);
    expect(bobUtxos[0].satoshis).toBe(1500n);
    expect(bobUtxos[1].satoshis).toBe(5245n);

    // raise the token satoshi value
    await bob.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        amount: 100n,
        category: category,
        value: 3000n,
      }),
    ]);
    newTokenUtxos = await bob.getTokenUtxos(category);
    expect(newTokenUtxos.length).toBe(1);
    expect(await bob.getTokenBalance(category)).toBe(100n);

    bobUtxos = await bob.getUtxos();
    expect(bobUtxos.length).toBe(2);
    expect(bobUtxos[0].satoshis).toBe(3000n);
    expect(bobUtxos[1].satoshis).toBe(3349n);
  });

  test("Test cashtoken waiting and watching", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    const genesisResponse = await alice.tokenGenesis({
      amount: 100n,
      value: 5000n,
      nft: {
        capability: NFTCapability.minting,
        commitment: "74657374",
      },
      cashaddr: alice.cashaddr!,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await alice.getTokenBalance(category);
    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await alice.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);
    expect(tokenUtxos[0].satoshis).toBe(5000n);

    // set up before the send, since only transactions new after setup are reported
    let bobTxId = ".";
    const txCancel = await bob.watchTokenTransactions((tx) => {
      bobTxId = tx.txid;
    });

    let seenBalance = 0n;
    let sendResponse: SendResponse = {};
    setTimeout(
      async () =>
        (sendResponse = await alice.send([
          new TokenSendRequest({
            cashaddr: bob.cashaddr!,
            amount: 100n,
            category: category,
            value: 1500n,
            nft: {
              capability: NFTCapability.minting,
              commitment: "74657374",
            },
          }),
        ])),
      0,
    );

    const cancel = await bob.watchTokenBalance(category, (balance) => {
      seenBalance = balance;
    });

    const balance = await bob.waitForTokenBalance(category, 100n);
    await delay(2000);
    expect(balance).toBe(100n);
    expect(seenBalance).toBe(100n);
    expect(sendResponse.txId).toBe(bobTxId);
    await cancel();
    await txCancel();
    await delay(500);
  });

  test("Test double genesis should not burn tokens", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    // prepare inputs for two token geneses
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis({
      amount: 100n,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await bob.getTokenBalance(category);

    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await bob.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);

    const genesis2Response = await bob.tokenGenesis({
      amount: 200n,
    });

    const category2 = genesis2Response.categories![0];
    const tokenBalance2 = await bob.getTokenBalance(category2);
    expect(tokenBalance2).toBe(200n);
    const tokenUtxos2 = await bob.getTokenUtxos(category2);
    expect(tokenUtxos2.length).toBe(1);

    expect((await bob.getTokenUtxos()).length).toBe(2);
  });

  test("Test sending tokens should not burn tokens", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    // prepare inputs for two token geneses
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis({
      amount: 100n,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await bob.getTokenBalance(category);

    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await bob.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);

    const genesis2Response = await bob.tokenGenesis({
      amount: 200n,
    });

    const category2 = genesis2Response.categories![0];
    const tokenBalance2 = await bob.getTokenBalance(category2);
    expect(tokenBalance2).toBe(200n);
    const tokenUtxos2 = await bob.getTokenUtxos(category2);
    expect(tokenUtxos2.length).toBe(1);

    expect((await bob.getTokenUtxos()).length).toBe(2);

    const charlie = await RegTestWallet.newRandom();
    await bob.send({
      cashaddr: charlie.cashaddr!,
      category: category,
      amount: 50n,
    });
    expect((await bob.getTokenUtxos()).length).toBe(2);
    expect((await charlie.getTokenUtxos()).length).toBe(1);
    expect(await bob.getTokenBalance(category)).toBe(50n);
    expect(await charlie.getTokenBalance(category)).toBe(50n);
  });

  test("Test sending bch should not burn tokens", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    // prepare inputs for two token geneses
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis({
      amount: 100n,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await bob.getTokenBalance(category);

    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await bob.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);

    await bob.send({ cashaddr: alice.cashaddr!, value: 1000n });

    const tokenBalance2 = await bob.getTokenBalance(category);
    expect(tokenBalance2).toBe(100n);
    const tokenUtxos2 = await bob.getTokenUtxos(category);
    expect(tokenUtxos2.length).toBe(1);
  });

  test("Test sending tokens should not burn tokens", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();
    // prepare inputs for two token geneses
    await alice.send([
      { cashaddr: bob.cashaddr!, value: 10000n },
      { cashaddr: charlie.cashaddr!, value: 10000n },
    ]);

    const genesisResponse = await bob.tokenGenesis({
      amount: 1001n,
    });

    const category = genesisResponse.categories![0];

    const tokenBalance = await bob.getTokenBalance(category);
    expect(tokenBalance).toBe(1001n);
    const tokenUtxos = await bob.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(1);

    await bob.send({ cashaddr: alice.cashaddr!, value: 1000n });

    await bob.send([
      {
        cashaddr: charlie.cashaddr!,
        category: category,
        amount: 5n,
      },
      {
        cashaddr: charlie.cashaddr!,
        category: category,
        amount: 501n,
      },
      {
        cashaddr: charlie.cashaddr!,
        category: category,
        amount: 95n,
      },
      {
        cashaddr: charlie.cashaddr!,
        category: category,
        amount: 100n,
      },
      {
        cashaddr: charlie.cashaddr!,
        category: category,
        amount: 300n,
      },
    ]);

    const tokenBalance2 = await bob.getTokenBalance(category);
    expect(tokenBalance2).toBe(0n);
    const tokenUtxos2 = await bob.getTokenUtxos(category);
    expect(tokenUtxos2.length).toBe(0);

    const tokenBalance3 = await charlie.getTokenBalance(category);
    expect(tokenBalance3).toBe(1001n);
    const tokenUtxos3 = await charlie.getTokenUtxos(category);
    expect(tokenUtxos3.length).toBe(5);

    // charlie sends some: the largest coin covers it, the others are not spent (mainnet-js#246)
    const coinAmounts = (coins: { token?: { amount: bigint } }[]) =>
      coins.map((val) => val.token!.amount).sort((a, b) => Number(a - b));
    const spentTokenAmounts = (transactionHex: string, coins: Utxo[]) => {
      const spent = inputOutpoints(transactionHex);
      return coinAmounts(
        coins.filter((val) => spent.includes(`${val.txid}:${val.vout}`)),
      );
    };
    const tokenOutputs = (transactionHex: string) =>
      decodeOutputs(transactionHex)
        .filter((val) => val.token)
        .map((val) => ({
          lockingBytecode: val.lockingBytecode,
          amount: val.token!.amount,
        }));

    const response4 = await charlie.send([
      {
        cashaddr: bob.cashaddr!,
        category: category,
        amount: 50n,
      },
    ]);
    expect(spentTokenAmounts(response4.transaction!, tokenUtxos3)).toEqual([
      501n,
    ]);
    // no implicit burn: what the coin carried minus what was sent comes back as change
    expect(tokenOutputs(response4.transaction!)).toEqual([
      { lockingBytecode: lockingBytecodeOf(bob.cashaddr!), amount: 50n },
      { lockingBytecode: lockingBytecodeOf(charlie.cashaddr!), amount: 451n },
    ]);
    expect(await charlie.getTokenBalance(category)).toBe(951n);
    const tokenUtxos4 = await charlie.getTokenUtxos(category);
    expect(coinAmounts(tokenUtxos4)).toEqual([5n, 95n, 100n, 300n, 451n]);
    expect(await bob.getTokenBalance(category)).toBe(50n);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);

    // an amount over several coins takes the largest ones until it is covered
    const response5 = await charlie.send([
      { cashaddr: bob.cashaddr!, category: category, amount: 600n },
      { cashaddr: bob.cashaddr!, category: category, amount: 200n },
    ]);
    expect(spentTokenAmounts(response5.transaction!, tokenUtxos4)).toEqual([
      100n,
      300n,
      451n,
    ]);
    expect(tokenOutputs(response5.transaction!)).toEqual([
      { lockingBytecode: lockingBytecodeOf(bob.cashaddr!), amount: 600n },
      { lockingBytecode: lockingBytecodeOf(bob.cashaddr!), amount: 200n },
      { lockingBytecode: lockingBytecodeOf(charlie.cashaddr!), amount: 51n },
    ]);
    const tokenUtxos5 = await charlie.getTokenUtxos(category);
    expect(coinAmounts(tokenUtxos5)).toEqual([5n, 51n, 95n]);

    // a coin in ensureUtxos counts first, no other coin is added when it covers the amount
    const small = tokenUtxos5.find((val) => val.token!.amount === 5n)!;
    const response6 = await charlie.send(
      [{ cashaddr: bob.cashaddr!, category: category, amount: 5n }],
      { ensureUtxos: [small] },
    );
    expect(spentTokenAmounts(response6.transaction!, tokenUtxos5)).toEqual([
      5n,
    ]);
    expect(tokenOutputs(response6.transaction!)).toEqual([
      { lockingBytecode: lockingBytecodeOf(bob.cashaddr!), amount: 5n },
    ]);

    // more than the wallet holds throws, nothing is sent
    await expect(
      charlie.send([
        { cashaddr: bob.cashaddr!, category: category, amount: 147n },
      ]),
    ).rejects.toThrow("Not enough token amount to send");

    expect(await charlie.getTokenBalance(category)).toBe(146n);
    expect(await bob.getTokenBalance(category)).toBe(855n);
  });

  test("Test minting NFTs not burn tokens", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();

    // prepare inputs for two token geneses
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis({
      nft: {
        capability: "minting",
        commitment: "",
      },
    });

    const category = genesisResponse.categories![0];

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);

    await bob.tokenMint({
      category: category,
      nft: {
        capability: "none",
        commitment: "0a",
      },
    });

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(2);
    expect((await bob.getTokenUtxos(category)).length).toBe(2);

    await bob.send(
      new TokenSendRequest({
        category: category,
        nft: {
          capability: "none",
          commitment: "0a",
        },
        cashaddr: charlie.cashaddr!,
      }),
    );
    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);

    expect(await charlie.getTokenBalance(category)).toBe(0n);
    expect(await charlie.getNftTokenBalance(category)).toBe(1);
    expect((await charlie.getTokenUtxos(category)).length).toBe(1);
  });

  test("Test sending NFTs after burning minting token", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();

    // prepare inputs for two token geneses
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await bob.waitForUpdate();

    const genesisResponse = await bob.tokenGenesis({
      nft: {
        capability: "minting",
        commitment: "",
      },
    });

    const category = genesisResponse.categories![0];

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);

    await bob.tokenMint({
      category: category,
      nft: {
        capability: "none",
        commitment: "0a",
      },
    });

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(2);
    expect((await bob.getTokenUtxos(category)).length).toBe(2);

    await bob.tokenMint({
      category: category,
      nft: {
        capability: "none",
        commitment: "0b",
      },
    });

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(3);
    expect((await bob.getTokenUtxos(category)).length).toBe(3);

    await bob.tokenBurn({
      category: category,
      nft: {
        capability: "minting",
        commitment: "",
      },
    });

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(2);
    expect((await bob.getTokenUtxos(category)).length).toBe(2);

    await bob.send(
      new TokenSendRequest({
        category: category,
        nft: {
          capability: "none",
          commitment: "0a",
        },
        cashaddr: charlie.cashaddr!,
      }),
    );
    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);

    expect(await charlie.getTokenBalance(category)).toBe(0n);
    expect(await charlie.getNftTokenBalance(category)).toBe(1);
    expect((await charlie.getTokenUtxos(category)).length).toBe(1);

    await bob.send(
      new TokenSendRequest({
        category: category,
        nft: {
          capability: "none",
          commitment: "0b",
        },
        cashaddr: charlie.cashaddr!,
      }),
    );
    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(0);
    expect((await bob.getTokenUtxos(category)).length).toBe(0);

    expect(await charlie.getTokenBalance(category)).toBe(0n);
    expect(await charlie.getNftTokenBalance(category)).toBe(2);
    expect((await charlie.getTokenUtxos(category)).length).toBe(2);
  });

  test("Test sending NFTs with empty commitment", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();

    // prepare inputs for two token geneses
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis({
      nft: {
        capability: "minting",
        commitment: "00",
      },
    });

    const category = genesisResponse.categories![0];

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);

    await bob.tokenMint({
      category: category,
      nft: {
        capability: "none",
        commitment: "0a",
      },
    });

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(2);
    expect((await bob.getTokenUtxos(category)).length).toBe(2);

    await bob.tokenMint({
      category: category,
      nft: {
        capability: "none",
        commitment: "0b",
      },
    });

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(3);
    expect((await bob.getTokenUtxos(category)).length).toBe(3);

    await bob.tokenBurn({
      category: category,
      nft: {
        capability: "minting",
        commitment: "00",
      },
    });

    expect(await bob.getTokenBalance(category)).toBe(0n);
    expect(await bob.getNftTokenBalance(category)).toBe(2);
    expect((await bob.getTokenUtxos(category)).length).toBe(2);

    await expect(
      bob.send(
        new TokenSendRequest({
          category: category,
          nft: {
            capability: "none",
            commitment: "",
          },
          cashaddr: charlie.cashaddr!,
        }),
      ),
    ).rejects.toThrow(
      "No suitable token utxos available to send token with id",
    );
  });

  test("Test splitting and merging FT and NFTs", async () => {
    // handle the cases from the following examples
    // https://bch.loping.net/tx/86f3c86e7e9c6853e489dc7ea85e2192b1b2cce691fa5ff9597e98f045a0bf72
    // https://bch.loping.net/tx/83ef2ab9687c53bb24c3d99f3cc7f0a2c7f23e180c8dbee5c845d1db6725d3e8

    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis({
      nft: {
        capability: "none",
        commitment: "0000000e",
      },
      amount: 10000n,
    });

    const category = genesisResponse.categories![0];

    expect(await bob.getTokenBalance(category)).toBe(10000n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);

    // explicitly split FT amounts from NFT
    await bob.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: "none",
          commitment: "0000000e",
        },
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        amount: 10000n,
      }),
    ]);

    expect(await bob.getTokenBalance(category)).toBe(10000n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(2);

    // add FT amount to an NFT
    await bob.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        amount: 9000n,
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: "none",
          commitment: "0000000e",
        },
        amount: 1000n,
      }),
    ]);

    expect(await bob.getTokenBalance(category)).toBe(10000n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(2);
    const tokenUtxos = await bob.getTokenUtxos(category);
    expect(tokenUtxos[0].token?.amount).toBe(9000n);
    expect(tokenUtxos[1].token?.amount).toBe(1000n);

    // merge FT and NFT into single utxo
    await bob.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: "none",
          commitment: "0000000e",
        },
        amount: 10000n,
      }),
    ]);

    expect(await bob.getTokenBalance(category)).toBe(10000n);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect((await bob.getTokenUtxos(category)).length).toBe(1);
  });

  test("Should encode unsigned transactions", async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const aliceWatchWallet = await RegTestWallet.watchOnly(
      aliceWallet.cashaddr!,
    );

    let category;
    {
      const aliceUtxos = await aliceWallet.getUtxos();

      const { unsignedTransaction, sourceOutputs, categories } =
        await aliceWatchWallet.tokenGenesis(
          {
            nft: {
              capability: "minting",
              commitment: "00",
            },
          },
          undefined,
          { buildUnsigned: true },
        );
      const encodedTransaction = hexToBin(unsignedTransaction!);
      expect(encodedTransaction.length).toBeGreaterThan(0);

      // check transaction was not submitted
      expect(json(aliceUtxos)).toBe(json(await aliceWallet.getUtxos()));

      const decoded = decodeTransaction(encodedTransaction);
      if (typeof decoded === "string") {
        throw decoded;
      }

      expect(
        binsAreEqual(decoded.inputs[0].unlockingBytecode, Uint8Array.from([])),
      ).toBe(true);
      expect(sourceOutputs!.length).toBe(decoded.inputs.length);
      expect(binToHex(decoded.outputs[0].token!.nft!.commitment)).toBe("00");

      const signed = await aliceWallet.signUnsignedTransaction(
        unsignedTransaction!,
        sourceOutputs!,
      );
      const statusChanged = aliceWallet.waitForUpdate({ timeout: 10000 });
      const watchStatusChanged = aliceWatchWallet.waitForUpdate({
        timeout: 10000,
      });
      await aliceWallet.submitTransaction(signed);
      await statusChanged;
      await watchStatusChanged;

      category = categories![0];

      expect(await aliceWallet.getNftTokenBalance(category)).toBe(1);
      const tokenUtxos = await aliceWallet.getTokenUtxos(category);
      expect(tokenUtxos.length).toBe(1);
      expect(tokenUtxos[0].token?.nft?.capability).toBe(NFTCapability.minting);
    }

    {
      const aliceUtxos = await aliceWallet.getUtxos();

      const { unsignedTransaction, sourceOutputs } =
        await aliceWatchWallet.tokenMint(
          {
            category: category,
            nft: {
              capability: "none",
              commitment: "0a",
            },
          },
          undefined,
          { buildUnsigned: true },
        );
      const encodedTransaction = hexToBin(unsignedTransaction!);
      expect(encodedTransaction.length).toBeGreaterThan(0);

      // check transaction was not submitted
      expect(json(aliceUtxos)).toBe(json(await aliceWallet.getUtxos()));

      const decoded = decodeTransaction(encodedTransaction);
      if (typeof decoded === "string") {
        throw decoded;
      }

      expect(
        binsAreEqual(decoded.inputs[0].unlockingBytecode, Uint8Array.from([])),
      ).toBe(true);
      expect(sourceOutputs!.length).toBe(decoded.inputs.length);
      expect(binToHex(sourceOutputs![0].token!.nft!.commitment)).toBe("00");
      expect(binToHex(decoded.outputs[0].token!.nft!.commitment)).toBe("00");
      expect(binToHex(decoded.outputs[1].token!.nft!.commitment)).toBe("0a");

      const signed = await aliceWallet.signUnsignedTransaction(
        unsignedTransaction!,
        sourceOutputs!,
      );
      const statusChanged2 = aliceWallet.waitForUpdate({ timeout: 10000 });
      const watchStatusChanged2 = aliceWatchWallet.waitForUpdate({
        timeout: 10000,
      });
      await aliceWallet.submitTransaction(signed);
      await statusChanged2;
      await watchStatusChanged2;

      expect(await aliceWallet.getNftTokenBalance(category)).toBe(2);
      const tokenUtxos = await aliceWallet.getTokenUtxos(category);
      expect(tokenUtxos.length).toBe(2);
      expect(
        tokenUtxos.filter(
          (val) => val.token?.nft?.capability === NFTCapability.minting,
        ).length,
      ).toBe(1);
      expect(
        tokenUtxos.filter(
          (val) => val.token?.nft?.capability === NFTCapability.none,
        ).length,
      ).toBe(1);
    }

    {
      const aliceUtxos = await aliceWallet.getUtxos();

      const { unsignedTransaction, sourceOutputs } =
        await aliceWatchWallet.send(
          [
            new TokenSendRequest({
              category: category,
              nft: {
                capability: "none",
                commitment: "0a",
              },
              cashaddr: aliceWallet.cashaddr!,
            }),
          ],
          { buildUnsigned: true },
        );
      const encodedTransaction = hexToBin(unsignedTransaction!);
      expect(encodedTransaction.length).toBeGreaterThan(0);

      // check transaction was not submitted
      expect(json(aliceUtxos)).toBe(json(await aliceWallet.getUtxos()));

      const decoded = decodeTransaction(encodedTransaction);
      if (typeof decoded === "string") {
        throw decoded;
      }

      expect(
        binsAreEqual(decoded.inputs[0].unlockingBytecode, Uint8Array.from([])),
      ).toBe(true);
      expect(sourceOutputs!.length).toBe(decoded.inputs.length);
      expect(binToHex(sourceOutputs![0].token!.nft!.commitment)).toBe("0a");
      expect(binToHex(decoded.outputs[0].token!.nft!.commitment)).toBe("0a");

      const signed = await aliceWallet.signUnsignedTransaction(
        unsignedTransaction!,
        sourceOutputs!,
      );
      await aliceWallet.submitTransaction(signed);
      expect(await aliceWallet.getNftTokenBalance(category)).toBe(2);
      const tokenUtxos = await aliceWallet.getTokenUtxos(category);
      expect(tokenUtxos.length).toBe(2);
      expect(
        tokenUtxos.filter(
          (val) => val.token?.nft?.capability === NFTCapability.minting,
        ).length,
      ).toBe(1);
      expect(
        tokenUtxos.filter(
          (val) => val.token?.nft?.capability === NFTCapability.none,
        ).length,
      ).toBe(1);
    }
  });

  test("Test enforcing token addresses", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const genesisResponse = await alice.tokenGenesis({
      amount: 100n,
    });
    const category = genesisResponse.categories![0];

    const previousValue = Config.EnforceCashTokenReceiptAddresses;

    const wrap = (addr) => {
      return new Promise((resolve) => {
        resolve(new TokenSendRequest({ cashaddr: addr, category, amount: 1n }));
      });
    };

    Config.EnforceCashTokenReceiptAddresses = false;
    await expect(wrap(alice.cashaddr)).resolves.not.toThrow();
    await expect(wrap(alice.tokenaddr)).resolves.not.toThrow();

    await expect(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.cashaddr!,
          category: category,
          amount: 1n,
        }),
      ),
    ).resolves.not.toThrow();

    await expect(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.tokenaddr!,
          category: category,
          amount: 2n,
        }),
      ),
    ).resolves.not.toThrow();

    Config.EnforceCashTokenReceiptAddresses = true;
    await expect(wrap(alice.cashaddr)).rejects.toThrow();
    await expect(wrap(alice.tokenaddr)).resolves.not.toThrow();

    await expect(
      (async () =>
        await alice.send(
          new TokenSendRequest({
            cashaddr: alice.cashaddr!,
            category: category,
            amount: 1n,
          }),
        ))(),
    ).rejects.toThrow();

    await expect(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.tokenaddr!,
          category: category,
          amount: 2n,
        }),
      ),
    ).resolves.not.toThrow();

    Config.EnforceCashTokenReceiptAddresses = previousValue;
  });

  test("Test genesis of multiple categories in a single transaction", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    // prepare two vout=0 inputs for two-category genesis
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis([
      { amount: 1000n },
      {
        amount: 0n,
        nft: { capability: NFTCapability.minting, commitment: "babe" },
      },
    ]);

    expect(genesisResponse.txId).toBeDefined();
    expect(genesisResponse.categories!.length).toBe(2);

    const [ftCategory, nftCategory] = genesisResponse.categories!;
    expect(ftCategory).not.toBe(nftCategory);
    expect(await bob.getTokenBalance(ftCategory)).toBe(1000n);
    expect(await bob.getNftTokenBalance(nftCategory)).toBe(1);
  });

  test("Test genesis throws if fewer vout=0 inputs than requests", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    // only one funding tx -> only one vout=0 input
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    await expect(
      bob.tokenGenesis([{ amount: 1n }, { amount: 2n }]),
    ).rejects.toThrow(/Not enough vout=0 inputs/);
  });

  test("Test minting NFTs across two categories in a single transaction", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis([
      {
        amount: 10n,
        nft: { capability: NFTCapability.minting, commitment: "a1" },
      },
      {
        amount: 5n,
        nft: { capability: NFTCapability.minting, commitment: "b1" },
      },
    ]);
    const [catA, catB] = genesisResponse.categories!;

    const mintResponse = await bob.tokenMint(
      [
        new TokenMintRequest({
          category: catA,
          nft: { capability: NFTCapability.none, commitment: "a2" },
        }),
        new TokenMintRequest({
          category: catA,
          nft: { capability: NFTCapability.none, commitment: "a3" },
        }),
        new TokenMintRequest({
          category: catB,
          nft: { capability: NFTCapability.none, commitment: "b2" },
        }),
      ],
      true,
    );

    expect(mintResponse.txId).toBeDefined();
    // FT amounts deducted per category: catA had 10, minted 2 -> 8; catB had 5, minted 1 -> 4
    expect(await bob.getTokenBalance(catA)).toBe(8n);
    expect(await bob.getTokenBalance(catB)).toBe(4n);
    expect(await bob.getNftTokenBalance(catA)).toBe(3);
    expect(await bob.getNftTokenBalance(catB)).toBe(2);
  });

  test("Test burning multiple categories in a single transaction", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });

    const genesisResponse = await bob.tokenGenesis([
      { amount: 100n },
      { amount: 200n },
    ]);
    const [catA, catB] = genesisResponse.categories!;

    const burnResponse = await bob.tokenBurn(
      [
        new TokenBurnRequest({ category: catA, amount: 30n }),
        new TokenBurnRequest({ category: catB, amount: 200n }),
      ],
      "multi-burn",
    );

    expect(burnResponse.txId).toBeDefined();
    expect(await bob.getTokenBalance(catA)).toBe(70n);
    expect(await bob.getTokenBalance(catB)).toBe(0n);
  });

  test("tokenMint takes its minting NFT from utxoIds only", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr!, value: 100000n });

    const genesisResponse = await bob.tokenGenesis({
      nft: { capability: NFTCapability.minting, commitment: "" },
    });
    const category = genesisResponse.categories![0];
    // a second minting NFT of the same category
    await bob.tokenMint({
      category,
      nft: { capability: NFTCapability.minting, commitment: "02" },
    });

    const batons = (await bob.getTokenUtxos(category)).filter(
      (utxo) => utxo.token?.nft?.capability === NFTCapability.minting,
    );
    expect(batons.length).toBe(2);
    const bchUtxos = (await bob.getUtxos()).filter((utxo) => !utxo.token);
    expect(bchUtxos.length).toBe(1);

    // the baton tokenMint would pick first stays outside utxoIds
    const allowed = [batons[1], bchUtxos[0]];
    const response = await bob.tokenMint(
      {
        category,
        nft: { capability: NFTCapability.none, commitment: "03" },
      },
      false,
      { utxoIds: allowed, broadcast: false },
    );
    expect(inputOutpoints(response.transaction!)).toEqual(
      allowed.map((utxo) => `${utxo.txid}:${utxo.vout}`).sort(),
    );

    await expect(
      bob.tokenMint(
        { category, nft: { capability: NFTCapability.none, commitment: "" } },
        false,
        { utxoIds: [bchUtxos[0]], broadcast: false },
      ),
    ).rejects.toThrow(InsufficientFundsError);
  });

  test("tokenBurn takes its token inputs from utxoIds only", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr!, value: 100000n });

    const genesisResponse = await bob.tokenGenesis({ amount: 100n });
    const category = genesisResponse.categories![0];
    // split the fungible tokens over two utxos
    await bob.send(
      new TokenSendRequest({ cashaddr: bob.tokenaddr!, category, amount: 30n }),
    );

    const tokenUtxos = await bob.getTokenUtxos(category);
    expect(tokenUtxos.length).toBe(2);
    const bchUtxos = (await bob.getUtxos()).filter((utxo) => !utxo.token);
    expect(bchUtxos.length).toBe(1);

    // the token utxo tokenBurn would pick first stays outside utxoIds
    const target = tokenUtxos[1];
    const allowed = [target, bchUtxos[0]];
    const response = await bob.tokenBurn(
      new TokenBurnRequest({ category, amount: 10n }),
      "burn",
      { utxoIds: allowed, broadcast: false },
    );
    expect(inputOutpoints(response.transaction!)).toEqual(
      allowed.map((utxo) => `${utxo.txid}:${utxo.vout}`).sort(),
    );
    const tx = decodeTransaction(hexToBin(response.transaction!));
    if (typeof tx === "string") throw new Error(tx);
    const tokenOutputs = tx.outputs.filter((output) => output.token);
    expect(tokenOutputs.length).toBe(1);
    expect(tokenOutputs[0].token!.amount).toBe(target.token!.amount - 10n);

    await expect(
      bob.tokenBurn(new TokenBurnRequest({ category, amount: 10n }), "burn", {
        utxoIds: [bchUtxos[0]],
        broadcast: false,
      }),
    ).rejects.toThrow(InsufficientFundsError);
  });
});

// Token change is what the spent token coins carry minus what the requests send (mainnet-js#247)
describe("token change", () => {
  const fundedWallet = async (coins = 1) => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    for (let i = 0; i < coins; i++) {
      await alice.send({ cashaddr: bob.cashaddr!, value: 100000n });
    }
    return bob;
  };

  // the requests' exact outputs, without the change the fix is about
  const splitCoins = (wallet: RegTestWallet, requests: TokenSendRequest[]) =>
    wallet.send(requests, { checkTokenQuantities: false });

  const bchChange = (wallet: RegTestWallet) => ({
    lockingBytecode: lockingBytecodeOf(wallet.cashaddr!),
    value: expect.any(BigInt),
    token: undefined,
  });

  const outpointsOf = (...coins: Utxo[]) =>
    coins.map((coin) => `${coin.txid}:${coin.vout}`).sort();

  // the token coins among a transaction's inputs, every input being one of the wallet's coins
  const spentTokenCoins = (transactionHex: string, coins: Utxo[]) => {
    const spent = inputOutpoints(transactionHex);
    expect(outpointsOf(...coins)).toEqual(expect.arrayContaining(spent));
    return outpointsOf(
      ...coins.filter(
        (coin) => coin.token && spent.includes(`${coin.txid}:${coin.vout}`),
      ),
    );
  };

  test("a fungible send keeps the minting NFT of a hybrid coin it spends", async () => {
    const bob = await fundedWallet();
    const carol = await RegTestWallet.newRandom();
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const genesis = await bob.tokenGenesis({ amount: 1000n, nft: minting });
    const category = genesis.categories![0];
    await splitCoins(bob, [
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category,
        nft: minting,
        amount: 900n,
      }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category,
        amount: 100n,
      }),
    ]);

    // the fungible-only coin covers the amount, the hybrid is not spent (mainnet-js#246)
    let coins = [...(await bob.getUtxos())];
    const fungible = coins.find((coin) => coin.token && !coin.token.nft)!;
    const first = await bob.send(
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category,
        amount: 50n,
      }),
    );
    expect(spentTokenCoins(first.transaction!, coins)).toEqual(
      outpointsOf(fungible),
    );
    expect(decodeOutputs(first.transaction!)).toEqual([
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category, amount: 50n, nft: undefined },
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 1000n,
        token: { category, amount: 50n, nft: undefined },
      },
      bchChange(bob),
    ]);

    // a spent hybrid keeps its own amount, the rest of the change is a fungible coin
    coins = [...(await bob.getUtxos())];
    const tokenCoins = await bob.getTokenUtxos(category);
    const second = await bob.send(
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category,
        amount: 10n,
      }),
      { ensureUtxos: tokenCoins },
    );
    expect(spentTokenCoins(second.transaction!, coins)).toEqual(
      outpointsOf(...tokenCoins),
    );
    expect(decodeOutputs(second.transaction!)).toEqual([
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category, amount: 10n, nft: undefined },
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 1000n,
        token: { category, amount: 900n, nft: minting },
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 1000n,
        token: { category, amount: 40n, nft: undefined },
      },
      bchChange(bob),
    ]);

    // an amount the fungible-only coins fall short of takes the hybrid, its NFT comes back
    coins = [...(await bob.getUtxos())];
    const third = await bob.send(
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category,
        amount: 940n,
      }),
    );
    expect(spentTokenCoins(third.transaction!, coins)).toEqual(
      outpointsOf(...coins.filter((coin) => coin.token)),
    );
    expect(decodeOutputs(third.transaction!)).toEqual([
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category, amount: 940n, nft: undefined },
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 1000n,
        token: { category, amount: 0n, nft: minting },
      },
      bchChange(bob),
    ]);
    expect(await bob.getNftTokenBalance(category)).toBe(1);
    expect(await carol.getTokenBalance(category)).toBe(1000n);
  });

  test("sending a minting NFT leaves no copy of it on the fungible change", async () => {
    const bob = await fundedWallet();
    const carol = await RegTestWallet.newRandom();
    const minting = { capability: NFTCapability.minting, commitment: "01" };
    const genesis = await bob.tokenGenesis({ amount: 1000n, nft: minting });
    const category = genesis.categories![0];
    await splitCoins(bob, [
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category,
        nft: minting,
      }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category,
        amount: 1000n,
      }),
    ]);

    // a fungible request with it, as a send of the NFT alone does not spend the fungible coin
    const coins = [...(await bob.getUtxos())];
    const response = await bob.send([
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category,
        nft: minting,
      }),
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category,
        amount: 10n,
      }),
    ]);
    expect(spentTokenCoins(response.transaction!, coins)).toEqual(
      outpointsOf(...coins.filter((coin) => coin.token)),
    );
    expect(decodeOutputs(response.transaction!)).toEqual([
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category, amount: 0n, nft: minting },
      },
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category, amount: 10n, nft: undefined },
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 1000n,
        token: { category, amount: 990n, nft: undefined },
      },
      bchChange(bob),
    ]);
    expect(await bob.getNftTokenBalance(category)).toBe(0);
    expect(await bob.getTokenBalance(category)).toBe(990n);
  });

  test("an immutable NFT is sendable while the wallet holds fungible tokens of its category", async () => {
    const bob = await fundedWallet();
    const carol = await RegTestWallet.newRandom();
    const nft = { capability: NFTCapability.none, commitment: "aa" };
    const genesis = await bob.tokenGenesis({ amount: 1000n, nft });
    const category = genesis.categories![0];
    await splitCoins(bob, [
      new TokenSendRequest({ cashaddr: bob.tokenaddr!, category, nft }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category,
        amount: 1000n,
      }),
    ]);

    // the fungible coin is not spent (mainnet-js#246)
    const coins = [...(await bob.getUtxos())];
    const response = await bob.send(
      new TokenSendRequest({ cashaddr: carol.tokenaddr!, category, nft }),
    );
    expect(spentTokenCoins(response.transaction!, coins)).toEqual(
      outpointsOf(...coins.filter((coin) => coin.token?.nft)),
    );
    expect(decodeOutputs(response.transaction!)).toEqual([
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category, amount: 0n, nft },
      },
      bchChange(bob),
    ]);
    expect(await bob.getTokenBalance(category)).toBe(1000n);
  });

  test("a send over several categories returns each category's own change", async () => {
    const bob = await fundedWallet(3);
    const carol = await RegTestWallet.newRandom();
    const immutable = { capability: NFTCapability.none, commitment: "aa" };
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const mutable = { capability: NFTCapability.mutable, commitment: "01" };
    const genesis = await bob.tokenGenesis([
      { amount: 500n, nft: immutable },
      { amount: 300n, nft: minting },
      { amount: 200n, nft: mutable },
    ]);
    const [hybridCategory, mintingCategory, mutableCategory] =
      genesis.categories!;
    await splitCoins(bob, [
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category: hybridCategory,
        nft: immutable,
        amount: 500n,
      }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category: mintingCategory,
        nft: minting,
      }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category: mintingCategory,
        amount: 300n,
      }),
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category: mutableCategory,
        nft: mutable,
        amount: 200n,
      }),
    ]);

    // fungible tokens off the hybrid, the minting NFT without the fungible coin of its category,
    // and the mutable NFT with a new commitment
    const mutated = { capability: NFTCapability.mutable, commitment: "02" };
    const coins = [...(await bob.getUtxos())];
    const response = await bob.send([
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category: hybridCategory,
        amount: 200n,
      }),
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category: mintingCategory,
        nft: minting,
      }),
      new TokenSendRequest({
        cashaddr: carol.tokenaddr!,
        category: mutableCategory,
        nft: mutated,
      }),
    ]);
    expect(spentTokenCoins(response.transaction!, coins)).toEqual(
      outpointsOf(...coins.filter((coin) => coin.token?.nft)),
    );
    expect(decodeOutputs(response.transaction!)).toEqual([
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category: hybridCategory, amount: 200n, nft: undefined },
      },
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category: mintingCategory, amount: 0n, nft: minting },
      },
      {
        lockingBytecode: lockingBytecodeOf(carol.tokenaddr!),
        value: 1000n,
        token: { category: mutableCategory, amount: 0n, nft: mutated },
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 1000n,
        token: { category: mutableCategory, amount: 200n, nft: undefined },
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 1000n,
        token: { category: hybridCategory, amount: 300n, nft: immutable },
      },
      bchChange(bob),
    ]);
  });

  test("a token coin in ensureUtxos of a category the send does not name comes back as change", async () => {
    const bob = await fundedWallet();
    const carol = await RegTestWallet.newRandom();
    const nft = { capability: NFTCapability.none, commitment: "cc" };
    const genesis = await bob.tokenGenesis({ amount: 10n, nft, value: 2000n });
    const category = genesis.categories![0];
    const [tokenCoin] = await bob.getTokenUtxos(category);
    const coins = [...(await bob.getUtxos())];

    const response = await bob.send(
      new SendRequest({ cashaddr: carol.cashaddr!, value: 5000n }),
      { ensureUtxos: [tokenCoin] },
    );
    expect(spentTokenCoins(response.transaction!, coins)).toEqual(
      outpointsOf(tokenCoin),
    );
    expect(decodeOutputs(response.transaction!)).toEqual([
      {
        lockingBytecode: lockingBytecodeOf(carol.cashaddr!),
        value: 5000n,
        token: undefined,
      },
      {
        lockingBytecode: lockingBytecodeOf(bob.tokenaddr!),
        value: 2000n,
        token: { category, amount: 10n, nft },
      },
      bchChange(bob),
    ]);
  });
});
