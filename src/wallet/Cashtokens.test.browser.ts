import { disconnectProviders, initProviders } from "#test/providers.js";
import {
  getNftTokenBalance,
  getTokenBalance,
  getTokenUtxos,
} from "#test/balances.js";
import { binToHex, utf8ToBin } from "@bitauth/libauth";
import { NFTCapability } from "../interface.js";
import { TokenMintRequest, TokenSendRequest } from "./model.js";
import { RegTestWallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe(`Cashtokens should function in the browser`, () => {
  test(`Test fungible cashtoken genesis and sending`, async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const genesisResponse = await alice.tokenGenesis({
      amount: 100n,
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await getTokenUtxos(alice, category);
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
    ]);
    const newTokenUtxos = await getTokenUtxos(alice, category);
    expect(newTokenUtxos.length).toBe(2);
    expect(await getTokenBalance(alice, category)).toBe(75n);
    expect(await getTokenBalance(bob, category)).toBe(25n);
  });

  test(`Test NFT cashtoken genesis and sending`, async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.cashaddr!,
      nft: {
        capability: NFTCapability.mutable,
        commitment: "abcd",
      },
    });

    const category = genesisResponse.categories![0];
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(0n);
    const tokenUtxos = await getTokenUtxos(alice, category);
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
    expect(await getTokenBalance(alice, category)).toBe(0n);
    const newTokenUtxos = await getTokenUtxos(alice, category);
    expect(newTokenUtxos.length).toBe(0);

    expect(await getTokenBalance(bob, category)).toBe(0n);
    const bobTokenUtxos = await getTokenUtxos(bob, category);
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
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(0n);
    const tokenUtxos = await getTokenUtxos(alice, category);
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
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(0n);
    const tokenUtxos = await getTokenUtxos(alice, category);
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
    expect(await getTokenBalance(alice, category)).toBe(0n);
    const newTokenUtxos = await getTokenUtxos(alice, category);
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
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(0n);
    const tokenUtxos = await getTokenUtxos(alice, category);
    expect(tokenUtxos.length).toBe(1);
    const response = await alice.tokenMint([
      new TokenMintRequest({
        category: category,
        cashaddr: alice.cashaddr!,
        nft: {
          capability: NFTCapability.none,
          commitment: "74657374",
        },
      }),
      new TokenMintRequest({
        category: category,
        cashaddr: alice.cashaddr!,
        nft: {
          capability: NFTCapability.none,
          commitment: "7465737432",
        },
      }),
    ]);
    expect(await getTokenBalance(alice, category)).toBe(0n);
    const newTokenUtxos = await getTokenUtxos(alice, category);
    expect(newTokenUtxos.length).toBe(3);
    expect(category).toEqual(response.categories![0]);
  });

  test("Test minting NFTs keeps the minting NFT's fungible tokens", async () => {
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
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(4n);
    const tokenUtxos = await getTokenUtxos(alice, category);
    expect(tokenUtxos.length).toBe(1);

    // mint 2 NFTs; the minting NFT keeps its fungible tokens
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
          commitment: "0b",
        },
      }),
    ]);
    expect(await getTokenBalance(alice, category)).toBe(4n);
    const newTokenUtxos = await getTokenUtxos(alice, category);
    expect(newTokenUtxos.length).toBe(3);
    expect(category).toEqual(response.categories![0]);

    // mint 2 more NFTs
    const ftResponse = await alice.tokenMint([
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
    ]);
    expect(await getTokenBalance(alice, category)).toBe(4n);
    const ftTokenUtxos = await getTokenUtxos(alice, category);
    expect(ftTokenUtxos.length).toBe(5);
    expect(category).toEqual(ftResponse.categories![0]);

    // and 3 more
    const ft2Response = await alice.tokenMint([
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
    ]);
    expect(await getTokenBalance(alice, category)).toBe(4n);
    const ft2TokenUtxos = await getTokenUtxos(alice, category);
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
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(4n);
    const tokenUtxos = await getTokenUtxos(alice, category);
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
    expect(rawTx.vout.length).toEqual(3);
    expect(rawTx.vout[0].scriptPubKey.type).toEqual("nulldata");
    expect(rawTx.vout[0].scriptPubKey.hex).toContain(
      binToHex(utf8ToBin("burn")),
    );
    expect(await getTokenBalance(alice, category)).toBe(0n);
    const newTokenUtxos = await getTokenUtxos(alice, category);
    expect(newTokenUtxos.length).toBe(0);
    expect(category).toEqual(response.categories![0]);
  });

  test("Test explicit burning of FT+NFT", async () => {
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
    const tokenBalance = await getTokenBalance(alice, category);
    expect(tokenBalance).toBe(4n);
    const tokenUtxos = await getTokenUtxos(alice, category);
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
    expect(rawTx.vout.length).toEqual(3);
    expect(rawTx.vout[0].scriptPubKey.type).toEqual("nulldata");
    expect(rawTx.vout[0].scriptPubKey.hex).toContain(
      binToHex(utf8ToBin("burn")),
    );
    expect(await getTokenBalance(alice, category)).toBe(3n);
    const newTokenUtxos = await getTokenUtxos(alice, category);
    expect(newTokenUtxos.length).toBe(1);
    expect(await getNftTokenBalance(alice, category)).toBe(1);
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
    expect(await getTokenBalance(alice, category)).toBe(0n);
    const ftTokenUtxos = await getTokenUtxos(alice, category);
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
    expect(await getTokenBalance(alice, category)).toBe(0n);
    const nftTokenUtxos = await getTokenUtxos(alice, category);
    expect(nftTokenUtxos.length).toBe(0);
    expect(category).toEqual(nftResponse.categories![0]);
    expect(await getNftTokenBalance(alice, category)).toBe(0);
    expect(await getNftTokenBalance(alice, category)).toBe(0);
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
    const tokenBalance = await getTokenBalance(bob, category);
    expect(tokenBalance).toBe(100n);
    const tokenUtxos = await getTokenUtxos(bob, category);
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
    let newTokenUtxos = await getTokenUtxos(bob, category);
    expect(newTokenUtxos.length).toBe(1);
    expect(await getTokenBalance(bob, category)).toBe(100n);

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
    newTokenUtxos = await getTokenUtxos(bob, category);
    expect(newTokenUtxos.length).toBe(1);
    expect(await getTokenBalance(bob, category)).toBe(100n);

    bobUtxos = await bob.getUtxos();
    expect(bobUtxos.length).toBe(2);
    expect(bobUtxos[0].satoshis).toBe(3000n);
    expect(bobUtxos[1].satoshis).toBe(3349n);
  });
});
