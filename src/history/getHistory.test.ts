import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeCashAddress,
  encodeTransaction,
  flattenBinArray,
  hexToBin,
  Opcodes,
} from "@bitauth/libauth";
import { countRequests } from "#test/countRequests.js";
import { mine } from "#test/mine.js";
import { signP2pkhInputs } from "#test/sign.js";
import ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { Utxo } from "../interface.js";
import { sumUtxoValue } from "../util/index.js";
import { RegTestHDWallet } from "../wallet/HDWallet.js";
import { RegTestWallet } from "../wallet/Wif.js";
import { getHistory } from "./getHistory.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

test("Should get miner history", async () => {
  const alice = await RegTestWallet.newRandom();
  const minerWallet = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
  await minerWallet.send({ cashaddr: alice.cashaddr!, value: 10000n });
  await mine({ cashaddr: minerWallet.getDepositAddress(), blocks: 1 });
  const history = await alice.getHistory();
  expect(history.length).toBeGreaterThan(0);
});

// // This class transforms outputs from electrum to a standard array of history.
test("Should get an address history", async () => {
  // Build Alice's wallet from Wallet Import Format string
  if (!process.env.PRIVATE_WIF) {
    throw Error("Attempted to pass an empty WIF");
  } else {
    let alice = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF); // insert WIF from #1
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();
    let sendResponse = await alice.send([
      {
        cashaddr: bob.cashaddr!,
        value: 31000n,
      },
      {
        cashaddr: charlie.cashaddr!,
        value: 41000n,
      },
    ]);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });
    await bob.send([
      {
        cashaddr: charlie.cashaddr!,
        value: 2100n,
      },
    ]);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 1 });
    await bob.send([
      {
        cashaddr: alice.cashaddr!,
        value: 2100n,
      },
    ]);
    expect(sendResponse!.txId!.length).toBe(64);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });

    // Build Bob's wallet from a public address, check his balance.
    const bobHistory = await bob.getHistory();
    expect(bobHistory[0].valueChange).toBe(-2320);
    expect(
      bobHistory[0].outputs.some(
        (output) => output.address === alice.getDepositAddress(),
      ),
    ).toBe(true);
    expect(
      bobHistory[0].inputs.some(
        (input) => input.address === bob.getDepositAddress(),
      ),
    ).toBe(true);
    expect(bobHistory[1].valueChange).toBe(-2320);
    expect(
      bobHistory[1].inputs.some(
        (input) => input.address === bob.getDepositAddress(),
      ),
    ).toBe(true);
    expect(
      bobHistory[1].outputs.some(
        (output) => output.address === charlie.getDepositAddress(),
      ),
    ).toBe(true);
    expect(bobHistory[2].valueChange).toBe(31000);
    expect(bobHistory[2].balance).toBe(31000);
    expect(bobHistory[2].fee).not.toBe(0);
    expect(
      bobHistory[2].inputs.some(
        (input) => input.address === alice.getDepositAddress(),
      ),
    ).toBe(true);
  }
});

// This class transforms outputs from electrum to a standard array of history.
test("Should get a history with multi-party sends", async () => {
  // Build Alice's wallet from Wallet Import Format string
  if (!process.env.PRIVATE_WIF) {
    throw Error("Attempted to pass an empty WIF");
  } else {
    let alice = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF); // insert WIF from #1
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();
    let sendResponse = await alice.send([
      {
        cashaddr: bob.cashaddr!,
        value: 31000n,
      },
    ]);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });
    await bob.send([
      {
        cashaddr: charlie.cashaddr!,
        value: 2100n,
      },
    ]);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 1 });
    await bob.send([
      {
        cashaddr: alice.cashaddr!,
        value: 2100n,
      },
    ]);
    expect(sendResponse!.txId!.length).toBe(64);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 1 });

    // Build Bob's wallet from a public address, check his balance.
    const bobHistory = await bob.getHistory();

    expect(bobHistory[1].fee).toBeGreaterThan(120);
    expect(bobHistory[1].fee).toBe(220);
    expect(bobHistory[0].valueChange).toBe(-2320);
    expect(
      bobHistory[0].outputs.some(
        (output) => output.address === alice.getDepositAddress(),
      ),
    ).toBe(true);
    expect(
      bobHistory[0].inputs.some(
        (input) => input.address === bob.getDepositAddress(),
      ),
    ).toBe(true);
    expect(bobHistory[1].valueChange).toBe(-2320);
    expect(
      bobHistory[1].outputs.some(
        (output) => output.address === charlie.getDepositAddress(),
      ),
    ).toBe(true);
    expect(
      bobHistory[1].inputs.some(
        (input) => input.address === bob.getDepositAddress(),
      ),
    ).toBe(true);

    expect(bobHistory[2].valueChange).toBe(31000);
    expect(bobHistory[2].fee).not.toBe(0);
    expect(
      bobHistory[2].inputs.some(
        (input) => input.address === alice.getDepositAddress(),
      ),
    ).toBe(true);
  }
});

// This class transforms outputs from electrum to a standard array of history.
test("Should cut results with a longer history to given count", async () => {
  // Build Alice's wallet from Wallet Import Format string
  if (!process.env.PRIVATE_WIF) {
    throw Error("Attempted to pass an empty WIF");
  } else {
    let alice = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF); // insert WIF from #1
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();
    let sendResponse = await alice.send([
      {
        cashaddr: bob.cashaddr!,
        value: 31000n,
      },
    ]);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });
    await bob.send([
      {
        cashaddr: charlie.cashaddr!,
        value: 2100n,
      },
      {
        cashaddr: alice.cashaddr!,
        value: 2100n,
      },
      {
        cashaddr: alice.cashaddr!,
        value: 2100n,
      },
    ]);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 1 });
    expect(sendResponse!.txId!.length).toBe(64);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });

    // Build Bob's wallet from a public address, check his balance.
    const bobHistory = await bob.getHistory({ count: 2 });
    expect(bobHistory.length).toBe(2);

    expect(bobHistory[0].valueChange).toBe(-6588);
    expect(
      bobHistory[0].outputs.some(
        (output) => output.address === alice.getDepositAddress(),
      ),
    ).toBe(true);
    expect(bobHistory[1].valueChange).toBe(31000);
    expect(
      bobHistory[1].outputs.some(
        (output) => output.address === alice.getDepositAddress(),
      ),
    ).toBe(true);
  }
});

// This class transforms outputs from electrum to a standard array of history.
test("Should handle input and fee from many utxos", async () => {
  // Build Alice's wallet from Wallet Import Format string
  if (!process.env.PRIVATE_WIF) {
    throw Error("Attempted to pass an empty WIF");
  } else {
    let alice = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF); // insert WIF from #1
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();
    let sendResponse = await alice.send([
      {
        cashaddr: bob.cashaddr!,
        value: 600n,
      },
      {
        cashaddr: bob.cashaddr!,
        value: 600n,
      },
      {
        cashaddr: bob.cashaddr!,
        value: 600n,
      },
      {
        cashaddr: bob.cashaddr!,
        value: 600n,
      },
    ]);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });
    await bob.sendMax(charlie.cashaddr!);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 1 });
    expect(sendResponse!.txId!.length).toBe(64);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });

    // Build Bob's wallet from a public address, check his balance.
    const bobHistory = await bob.getHistory();

    expect(bobHistory[0].valueChange).toBeLessThan(-1700);
    expect(
      bobHistory[0].outputs.some(
        (output) => output.address === charlie.getDepositAddress(),
      ),
    ).toBe(true);
    expect(
      bobHistory[1].inputs.some(
        (input) => input.address === alice.getDepositAddress(),
      ),
    ).toBe(true);
  }
});

test("Should report outpoints and locking bytecode, and give scripts without an address a placeholder", async () => {
  const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
  const bob = await RegTestWallet.newRandom();
  await miner.send({ cashaddr: bob.cashaddr!, value: 10000n });
  const [funding] = await bob.getUtxos();

  const bobLockingBytecode = (() => {
    const result = cashAddressToLockingBytecode(bob.cashaddr!);
    if (typeof result === "string") throw new Error(result);
    return result.bytecode;
  })();
  // P2S, anyone can spend with an empty unlocking bytecode
  const p2s = Uint8Array.from([Opcodes.OP_1]);
  const p2pk = flattenBinArray([
    Uint8Array.from([33]),
    bob.publicKeyCompressed!,
    Uint8Array.from([Opcodes.OP_CHECKSIG]),
  ]);
  const bareMultisig = flattenBinArray([
    Uint8Array.from([Opcodes.OP_1, 33]),
    bob.publicKeyCompressed!,
    Uint8Array.from([Opcodes.OP_1, Opcodes.OP_CHECKMULTISIG]),
  ]);

  const unsigned = encodeTransaction({
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
      { lockingBytecode: p2s, valueSatoshis: 2000n },
      { lockingBytecode: p2pk, valueSatoshis: 2000n },
      { lockingBytecode: bareMultisig, valueSatoshis: 2000n },
      { lockingBytecode: bobLockingBytecode, valueSatoshis: 3000n },
    ],
  });
  const signed = signP2pkhInputs(
    unsigned,
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
    bob.privateKey,
  );
  const scriptsTxId = await bob.submitTransaction(signed);

  // spend the P2S output back to bob, so a history input has no address either
  const spendTxId = await bob.submitTransaction(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: hexToBin(scriptsTxId),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: Uint8Array.from([]),
        },
      ],
      outputs: [{ lockingBytecode: bobLockingBytecode, valueSatoshis: 1800n }],
    }),
  );
  await mine({ cashaddr: miner.getDepositAddress(), blocks: 1 });

  const history = await bob.getHistory();
  const scriptsTx = history.find((tx) => tx.hash === scriptsTxId)!;
  const spendTx = history.find((tx) => tx.hash === spendTxId)!;

  expect(scriptsTx.inputs).toEqual([
    expect.objectContaining({
      address: bob.cashaddr,
      outpointTransactionHash: funding.txid,
      outpointIndex: funding.vout,
      lockingBytecode: binToHex(bobLockingBytecode),
    }),
  ]);
  expect(
    scriptsTx.outputs.map(({ address, lockingBytecode }) => ({
      address,
      lockingBytecode,
    })),
  ).toEqual([
    { address: `SCRIPT: ${binToHex(p2s)}`, lockingBytecode: binToHex(p2s) },
    { address: `SCRIPT: ${binToHex(p2pk)}`, lockingBytecode: binToHex(p2pk) },
    {
      address: `SCRIPT: ${binToHex(bareMultisig)}`,
      lockingBytecode: binToHex(bareMultisig),
    },
    { address: bob.cashaddr, lockingBytecode: binToHex(bobLockingBytecode) },
  ]);
  expect(scriptsTx.valueChange).toBe(3000 - 10000);

  expect(spendTx.inputs).toEqual([
    expect.objectContaining({
      address: `SCRIPT: ${binToHex(p2s)}`,
      value: 2000,
      outpointTransactionHash: scriptsTxId,
      outpointIndex: 0,
      lockingBytecode: binToHex(p2s),
    }),
  ]);
  expect(spendTx.valueChange).toBe(1800);
  expect(spendTx.fee).toBe(200);
});

describe("history load", () => {
  // the server's utxos of the addresses, token coins included
  const utxosFromServer = async (
    provider: ElectrumNetworkProvider,
    addresses: string[],
  ) => {
    const utxos: Utxo[] = [];
    for (const address of addresses) {
      utxos.push(...(await provider.getUtxos(address)));
    }
    return utxos;
  };

  test("an HD wallet's history takes its balance from the utxos, with the concurrency asked for", async () => {
    const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
    const hd = await RegTestHDWallet.newRandom();
    // 12 funding transactions at 6 heights, on 12 addresses
    for (let i = 0; i < 12; i++) {
      await miner.send({
        cashaddr: hd.getDepositAddress(i),
        value: 10000n + BigInt(i),
      });
      if (i % 2) await mine({ cashaddr: miner.getDepositAddress(), blocks: 1 });
    }
    await hd["waitForUpdate"]({ indices: { 0: 12 } });
    const genesis = await hd.tokenGenesis({
      cashaddr: hd.getTokenDepositAddress(12),
      amount: 500n,
      nft: { capability: "minting", commitment: "ab" },
    });
    // left in the mempool, spending coins of several addresses
    await hd.send({ cashaddr: miner.getDepositAddress(), value: 25000n });

    const provider = hd.provider as ElectrumNetworkProvider;
    const { counts, restore } = countRequests(provider);
    const history = await hd.getHistory({});
    const withTwo = { ...counts.byMethod };
    counts.maxInFlight = 0;
    await hd.getHistory({ concurrency: 2 });
    const maxInFlightWithTwo = counts.maxInFlight;
    restore();

    expect(counts.byMethod["blockchain.address.get_balance"]).toBeUndefined();
    expect(withTwo["blockchain.address.get_balance"]).toBeUndefined();
    expect(maxInFlightWithTwo).toBe(2);

    const utxos = await hd.getUtxos();
    expect(
      utxos.some((utxo) => utxo.token?.category === genesis.categories![0]),
    ).toBe(true);
    const addresses = (
      hd as unknown as { getUsedAddresses(): string[] }
    ).getUsedAddresses();
    // 13 deposit addresses and the change of the genesis and the send
    expect(addresses.length).toBe(15);
    const serverUtxos = await utxosFromServer(provider, addresses);
    const serverBalance = sumUtxoValue(serverUtxos);
    expect(sumUtxoValue(utxos)).toBe(serverBalance);
    expect(history.length).toBe(14);
    expect(history[0].blockHeight).toBe(0);
    expect(history[0].balance).toBe(Number(serverBalance));

    // the same items as from the server's utxos
    const rawHistory = await hd.getRawHistory();
    const reference = await getHistory({
      addresses,
      provider,
      rawHistory,
      utxos: serverUtxos,
    });
    expect(history).toEqual(reference);
  });

  test("transactions and headers load side by side, under one bound", async () => {
    const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
    const bob = await RegTestWallet.newRandom();
    for (let i = 0; i < 4; i++) {
      await miner.send({ cashaddr: bob.cashaddr!, value: 10000n });
      await mine({ cashaddr: miner.getDepositAddress(), blocks: 1 });
    }
    await bob.getBalance();

    // the methods in flight whenever a request starts
    const provider = bob.provider as ElectrumNetworkProvider;
    const target = provider as unknown as {
      performRequest<T>(method: string, parameters?: unknown[]): Promise<T>;
    };
    const original = target.performRequest.bind(provider);
    const inFlight: string[] = [];
    let maxInFlight = 0;
    let together = false;
    target.performRequest = async <T>(
      method: string,
      parameters?: unknown[],
    ): Promise<T> => {
      inFlight.push(method);
      maxInFlight = Math.max(maxInFlight, inFlight.length);
      together ||=
        inFlight.includes("blockchain.transaction.get") &&
        inFlight.includes("blockchain.header.get");
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await original<T>(method, parameters);
      } finally {
        inFlight.splice(inFlight.indexOf(method), 1);
      }
    };
    try {
      const history = await bob.getHistory({ concurrency: 3 });
      expect(history.length).toBe(4);
    } finally {
      delete (target as { performRequest?: unknown }).performRequest;
    }

    expect(together).toBe(true);
    expect(maxInFlight).toBe(3);
  });

  test("the first load of an HD wallet's history keeps up to 32 requests in flight", async () => {
    const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
    const hd = await RegTestHDWallet.newRandom();
    for (let i = 0; i < 12; i++) {
      await miner.send({ cashaddr: hd.getDepositAddress(i), value: 10000n });
    }
    await mine({ cashaddr: miner.getDepositAddress(), blocks: 1 });
    await hd["waitForUpdate"]({ indices: { 0: 12 } });

    const { counts, restore } = countRequests(
      hd.provider as ElectrumNetworkProvider,
    );
    const history = await hd.getHistory({});
    restore();

    expect(history.length).toBe(12);
    // 12 transactions and their prevouts, none cached, more than 10 in flight and at most 32
    expect(counts.byMethod["blockchain.transaction.get"]).toBeGreaterThan(12);
    expect(counts.maxInFlight).toBeGreaterThan(10);
    expect(counts.maxInFlight).toBeLessThanOrEqual(32);
  });

  test("a single-address wallet's history and balance come from its own snapshot", async () => {
    const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
    const bob = await RegTestWallet.newRandom();
    await miner.send({ cashaddr: bob.cashaddr!, value: 20000n });
    await mine({ cashaddr: miner.getDepositAddress(), blocks: 1 });
    await bob.tokenGenesis({ amount: 7n });

    const provider = bob.provider as ElectrumNetworkProvider;
    const { counts, restore } = countRequests(provider);
    const history = await bob.getHistory();
    restore();

    // neither is read from the server again, where it may have moved on since the wallet's update
    expect(counts.byMethod["blockchain.address.get_balance"]).toBeUndefined();
    expect(counts.byMethod["blockchain.address.get_history"]).toBeUndefined();
    const rawHistory = await bob.getRawHistory();
    expect(history.map((tx) => tx.hash).sort()).toEqual(
      rawHistory.map((tx) => tx.tx_hash).sort(),
    );
    const serverUtxos = await utxosFromServer(provider, [bob.cashaddr!]);
    expect(history[0].balance).toBe(Number(sumUtxoValue(serverUtxos)));
    const reference = await getHistory({
      addresses: [bob.cashaddr!],
      provider,
      utxos: serverUtxos,
    });
    expect(history).toEqual(reference);

    // the wallet keeps its raw history in the server's order, oldest first; `count` keeps the newest
    const newest = await getHistory({
      addresses: [bob.cashaddr!],
      provider,
      count: 1,
      rawHistory,
      utxos: serverUtxos,
    });
    expect(newest.map((tx) => tx.hash)).toEqual([history[0].hash]);
  });

  test("the history of several addresses is read per address, bounded", async () => {
    const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => RegTestWallet.newRandom()),
    );
    for (const wallet of wallets) {
      await miner.send({ cashaddr: wallet.cashaddr!, value: 5000n });
    }
    const addresses = wallets.map((wallet) => wallet.cashaddr!);
    const provider = wallets[0].provider as ElectrumNetworkProvider;
    const utxos = await utxosFromServer(provider, addresses);

    const { counts, restore } = countRequests(provider);
    const history = await getHistory({
      addresses,
      provider,
      utxos,
      concurrency: 3,
    });
    restore();

    expect(counts.byMethod["blockchain.address.get_history"]).toBe(6);
    expect(counts.byMethod["blockchain.address.get_balance"]).toBeUndefined();
    expect(counts.maxInFlight).toBe(3);
    expect(history[0].balance).toBe(30000);
  });
});

describe("a transaction the server sends that does not decode", () => {
  const address = encodeCashAddress({
    prefix: "bchreg",
    type: "p2pkh",
    payload: new Uint8Array(20),
  }).address;
  const txid = "33".repeat(32);
  // a transaction spending an output of `txid`, so that its prevout is fetched
  const spending = binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: hexToBin(txid),
          outpointIndex: 0,
          sequenceNumber: 0,
          unlockingBytecode: Uint8Array.of(),
        },
      ],
      outputs: [{ lockingBytecode: Uint8Array.of(0x51), valueSatoshis: 1n }],
    }),
  );
  const provider = (raw: Record<string, string>) =>
    ({
      getHeaders: async () => new Map(),
      getRawTransactions: async (hashes: string[]) =>
        new Map(hashes.map((hash) => [hash, raw[hash]])),
    }) as unknown as ElectrumNetworkProvider;

  test("in the history", async () => {
    const error = await getHistory({
      addresses: [address],
      provider: provider({ [txid]: "00" }),
      rawHistory: [{ tx_hash: txid, height: 0 }],
      utxos: [],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringMatching(/^Error reading transaction/),
    });
  });

  test("as a spent transaction", async () => {
    const error = await getHistory({
      addresses: [address],
      provider: provider({ ["44".repeat(32)]: spending, [txid]: "00" }),
      rawHistory: [{ tx_hash: "44".repeat(32), height: 0 }],
      utxos: [],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: expect.stringMatching(/^Error reading transaction/),
    });
  });
});
