import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeTransaction,
  flattenBinArray,
  hexToBin,
  Opcodes,
} from "@bitauth/libauth";
import { mine } from "../mine/index.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { toBch } from "../util/index.js";
import { createWallet } from "../wallet/createWallet.js";
import { WalletTypeEnum } from "../wallet/enum.js";
import { RegTestWallet } from "../wallet/Wif.js";

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
    const bob = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
    const charlie = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
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
    expect(toBch(sendResponse.balance!)).toBeGreaterThan(0.01);
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
    const bob = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
    const charlie = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
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
    expect(toBch(sendResponse.balance!)).toBeGreaterThan(0.01);
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
    const bob = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
    const charlie = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
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
    expect(toBch(sendResponse.balance!)).toBeGreaterThan(0.01);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });

    // Build Bob's wallet from a public address, check his balance.
    const bobHistory = await bob.getHistory({
      unit: "sat",
      start: 0,
      count: 2,
    });
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
    const bob = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
    const charlie = await createWallet({
      type: WalletTypeEnum.Wif,
      network: "regtest",
    });
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
    expect(toBch(sendResponse.balance!)).toBeGreaterThan(0.01);
    await mine({ cashaddr: alice.getDepositAddress(), blocks: 10 });

    // Build Bob's wallet from a public address, check his balance.
    const bobHistory = await bob.getHistory({
      unit: "sat",
    });

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
  const signed = await bob.signUnsignedTransaction(unsigned, [
    {
      outpointTransactionHash: hexToBin(funding.txid),
      outpointIndex: funding.vout,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: Uint8Array.from([]),
      lockingBytecode: bobLockingBytecode,
      valueSatoshis: funding.satoshis,
    },
  ]);
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
