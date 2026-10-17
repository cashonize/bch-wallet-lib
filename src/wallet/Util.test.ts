import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  hexToBin,
  Opcodes,
} from "@bitauth/libauth";
import type { CacheProvider } from "../cache/interface.js";
import { Config } from "../config.js";
import { NetworkType } from "../enum.js";
import { mine } from "../mine/index.js";
import { createMockProvider } from "../network/MockNetworkProvider.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { delay } from "../util/delay.js";
import { decodeTransaction, getTransactionHash } from "./Util.js";
import { RegTestWallet } from "./Wif.js";
import { liveTests } from "#test/live.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe("Utility tests", () => {
  test("Should compute raw transaction hash", async () => {
    expect(
      await getTransactionHash(
        "01000000015bb9142c960a838329694d3fe9ba08c2a6421c5158d8f7044cb7c48006c1b484000000006a4730440220229ea5359a63c2b83a713fcc20d8c41b20d48fe639a639d2a8246a137f29d0fc02201de12de9c056912a4e581a62d12fb5f43ee6c08ed0238c32a1ee769213ca8b8b412103bcf9a004f1f7a9a8d8acce7b51c983233d107329ff7c4fb53e44c855dbe1f6a4feffffff02c6b68200000000001976a9141041fb024bd7a1338ef1959026bbba860064fe5f88ac50a8cf00000000001976a91445dac110239a7a3814535c15858b939211f8529888ac61ee0700",
      ),
    ).toBe("36a3692a41a8ac60b73f7f41ee23f5c917413e5b2fad9e44b34865bd0d601a3d");
  });

  test("Should throw on non-existent transaction and invalid hash", async () => {
    await expect(
      decodeTransaction(
        "36a3692a41a8ac60b73f7f41ee23f5c917413e5b2fad9e44b34865bd0d601a3d",
        false,
        NetworkType.Regtest,
      ),
    ).rejects.toThrowError("might not exist");
    await expect(
      decodeTransaction("test", false, NetworkType.Regtest),
    ).rejects.toThrowError("Invalid tx hash");
  });

  test("Should get raw transaction", async () => {
    let wallet = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const utxo = (await wallet.getUtxos())[0];
    const transaction = await wallet.provider!.getRawTransactionObject(
      utxo.txid,
    );
    expect(
      (await decodeTransaction(transaction.hash, false, NetworkType.Regtest))
        .hash,
    ).toBe(utxo.txid);
    expect(
      (await decodeTransaction(transaction.hex, false, NetworkType.Regtest))
        .txid,
    ).toBe(utxo.txid);
  });

  test.skipIf(!liveTests)(
    "Should decode a transaction from fist block",
    async () => {
      const decoded = await decodeTransaction(
        "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098",
      );

      expect(decoded.txid).toBe(
        "0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098",
      );

      expect((decoded.vin[0] as any).address).toBeUndefined();
    },
  );

  test.skipIf(!liveTests)(
    "Should decode a transaction and fetch input values and addresses",
    async () => {
      const txHash =
        "dc8f059900807c36941313f10b43ec049e23dfede4e09f8fbccc3871ed359fbe";
      const decoded = await decodeTransaction(txHash, true);
      expect(decoded.vin[0].scriptPubKey.addresses[0]).toBeDefined();
      expect(decoded.vin[0].value).toBeDefined();
    },
  );
});

describe("decodeTransaction outputs", () => {
  test("gives OP_RETURN and P2S outputs a placeholder and keeps token data", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    const [funding] = await bob.getUtxos();
    const bobLockingBytecode = (() => {
      const result = cashAddressToLockingBytecode(bob.cashaddr!);
      if (typeof result === "string") throw new Error(result);
      return result.bytecode;
    })();

    // P2S, anyone can spend with an empty unlocking bytecode
    const p2s = Uint8Array.from([Opcodes.OP_1]);
    const opReturn = Uint8Array.from([Opcodes.OP_RETURN, 2, 0xab, 0xcd]);
    const signed = await bob.signUnsignedTransaction(
      encodeTransaction({
        version: 2,
        locktime: 0,
        inputs: [
          {
            outpointTransactionHash: hexToBin(funding.txid),
            outpointIndex: funding.vout,
            sequenceNumber: 0xffffffff,
            unlockingBytecode: Uint8Array.from([]),
          },
        ],
        outputs: [
          { lockingBytecode: opReturn, valueSatoshis: 0n },
          { lockingBytecode: p2s, valueSatoshis: 2000n },
          { lockingBytecode: bobLockingBytecode, valueSatoshis: 7000n },
        ],
      }),
      [
        {
          outpointTransactionHash: hexToBin(funding.txid),
          outpointIndex: funding.vout,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: Uint8Array.from([]),
          lockingBytecode: bobLockingBytecode,
          valueSatoshis: funding.satoshis,
        },
      ],
    );
    const scriptsTxId = await bob.submitTransaction(signed);
    const spendTxId = await bob.submitTransaction(
      encodeTransaction({
        version: 2,
        locktime: 0,
        inputs: [
          {
            outpointTransactionHash: hexToBin(scriptsTxId),
            outpointIndex: 1,
            sequenceNumber: 0xffffffff,
            unlockingBytecode: Uint8Array.from([]),
          },
        ],
        outputs: [
          { lockingBytecode: bobLockingBytecode, valueSatoshis: 1800n },
        ],
      }),
    );

    const expectedOutputs = [
      {
        address: `OP_RETURN: ${binToHex(opReturn)}`,
        hex: binToHex(opReturn),
        value: 0,
      },
      {
        address: `SCRIPT: ${binToHex(p2s)}`,
        hex: binToHex(p2s),
        value: 0.00002,
      },
      {
        address: bob.cashaddr,
        hex: binToHex(bobLockingBytecode),
        value: 0.00007,
      },
    ];
    const byHash = await decodeTransaction(
      scriptsTxId,
      false,
      NetworkType.Regtest,
    );
    const byHex = await decodeTransaction(
      binToHex(signed),
      false,
      NetworkType.Regtest,
    );
    for (const decoded of [byHash, byHex]) {
      expect(decoded.txid).toBe(scriptsTxId);
      expect(
        decoded.vout.map(({ scriptPubKey, value }) => ({
          address: scriptPubKey.addresses[0],
          hex: scriptPubKey.hex,
          value,
        })),
      ).toEqual(expectedOutputs);
    }

    const spend = await bob.decodeTransaction(spendTxId, true);
    expect(spend.vin[0].scriptPubKey.addresses).toEqual([
      `SCRIPT: ${binToHex(p2s)}`,
    ]);
    expect(spend.vin[0].value).toBe(0.00002);

    const genesis = await bob.tokenGenesis({
      amount: 100n,
      nft: { capability: "minting", commitment: "abcd" },
    });
    const category = genesis.categories[0];
    const decodedGenesis = await bob.decodeTransaction(genesis.txId);
    expect(decodedGenesis.vout[0].tokenData).toEqual({
      amount: "100",
      category,
      nft: { capability: "minting", commitment: "abcd" },
    });
    // the same shape as the server's verbose transaction
    const verbose = await bob.provider.getRawTransactionObject(genesis.txId);
    expect(decodedGenesis.vout[0].tokenData).toEqual(verbose.vout[0].tokenData);
    expect(decodedGenesis.vout[1].tokenData).toBeUndefined();
  });

  test("uses the given provider", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const utxo = (await alice.getUtxos())[0];
    const otherChain = await createMockProvider();
    await otherChain.connect();
    await expect(
      decodeTransaction(utxo.txid, false, undefined, { provider: otherChain }),
    ).rejects.toThrowError("might not exist");
    expect(
      (
        await decodeTransaction(utxo.txid, false, undefined, {
          provider: alice.provider,
        })
      ).txid,
    ).toBe(utxo.txid);
    await expect(
      decodeTransaction(utxo.txid, false, NetworkType.Mainnet, {
        provider: alice.provider,
      }),
    ).rejects.toThrowError("does not match the provider's network");
  });
});

describe("Dynamic confirmations via fetchHeight", () => {
  test("confirmations defaults to 0 for decoded mempool transactions", async () => {
    const decoded = await decodeTransaction(
      "01000000015bb9142c960a838329694d3fe9ba08c2a6421c5158d8f7044cb7c48006c1b484000000006a4730440220229ea5359a63c2b83a713fcc20d8c41b20d48fe639a639d2a8246a137f29d0fc02201de12de9c056912a4e581a62d12fb5f43ee6c08ed0238c32a1ee769213ca8b8b412103bcf9a004f1f7a9a8d8acce7b51c983233d107329ff7c4fb53e44c855dbe1f6a4feffffff02c6b68200000000001976a9141041fb024bd7a1338ef1959026bbba860064fe5f88ac50a8cf00000000001976a91445dac110239a7a3814535c15858b939211f8529888ac61ee0700",
      false,
      NetworkType.Regtest,
    );
    expect(decoded.confirmations).toBe(0);
  });

  test("confirmations is present on verbose server response", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const utxo = (await alice.getUtxos())[0];
    const transaction = await alice.provider.getRawTransactionObject(utxo.txid);
    expect(transaction.confirmations).toBeGreaterThan(0);
  });

  test("fetchHeight is not exposed in returned transaction", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const utxo = (await alice.getUtxos())[0];
    const transaction = await alice.provider.getRawTransactionObject(utxo.txid);
    expect((transaction as any).fetchHeight).toBeUndefined();
  });

  test("cached transaction has up-to-date confirmations", async () => {
    const indexedDbCacheValue = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;
    try {
      const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
      // the provider connected before the cache was turned on, so its cache is not open yet
      await (
        alice.provider as unknown as { cache: CacheProvider }
      ).cache.init();
      const utxo = (await alice.getUtxos())[0];

      const tx1 = await alice.provider.getRawTransactionObject(utxo.txid);
      const confirmations1 = tx1.confirmations;

      await mine({ cashaddr: alice.cashaddr!, blocks: 1 });
      await delay(1000);

      const tx2 = await alice.provider.getRawTransactionObject(utxo.txid);
      expect(tx2.confirmations).toBe(confirmations1 + 1);
      expect((tx2 as any).fetchHeight).toBeUndefined();
    } finally {
      Config.UseIndexedDBCache = indexedDbCacheValue;
    }
  });
});
