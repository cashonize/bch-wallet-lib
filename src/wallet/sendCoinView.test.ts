import {
  assertSuccess,
  binToHex,
  decodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
} from "@bitauth/libauth";
import { randomUtxo } from "@paryonusd/mem-cash";
import { getTokenBalance, waitForBalance } from "#test/balances.js";
import { mine } from "#test/mine.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { BaseWallet } from "./Base.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { SendResponse, TokenSendRequest, toUtxoId } from "./model.js";
import { RegTestWallet } from "./Wif.js";

// A send returns once the wallet's own coins reflect it: its inputs gone, its outputs to the
// wallet there, so that the next spend, built from those coins, does not double-spend

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

const useMock = !!process.env.USE_MOCK_PROVIDER;

// the transaction's spent outpoints, and its outputs to the wallet's own addresses
function coinsOf(wallet: BaseWallet, response: SendResponse) {
  const tx = assertSuccess(decodeTransaction(hexToBin(response.transaction)));
  const spent = tx.inputs.map(
    (input) =>
      `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`,
  );
  const own = tx.outputs.flatMap((output, vout) => {
    const result = lockingBytecodeToCashAddress({
      bytecode: output.lockingBytecode,
      prefix: "bchreg",
    });
    if (typeof result === "string") return [];
    return wallet.hasAddress(result.address)
      ? [`${response.txId}:${vout}`]
      : [];
  });
  return { spent, own };
}

// read at once after the send, with no waiting of the test's own
async function expectReflected(wallet: BaseWallet, response: SendResponse) {
  const { spent, own } = coinsOf(wallet, response);
  const ids = (await wallet.getUtxos()).map(toUtxoId);
  for (const id of spent) expect(ids).not.toContain(id);
  for (const id of own) expect(ids).toContain(id);
  return own;
}

async function fundedHd(value: bigint) {
  const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
  const hd = await RegTestHDWallet.newRandom();
  await miner.send({ cashaddr: hd.getDepositAddress(0), value });
  await hd["waitForUpdate"]({ indices: { 0: 1 } });
  expect(await hd.getBalance()).toBe(value);
  return { miner, hd };
}

describe("consecutive sends", () => {
  test("an HD wallet's second send spends the first one's change", async () => {
    const { miner, hd } = await fundedHd(20000n);

    const first = await hd.send({
      cashaddr: miner.getDepositAddress(),
      value: 3000n,
    });
    const [change] = await expectReflected(hd, first);
    expect(change).toBeDefined();
    // the change went to a new change address, now watched and counted as used
    expect(hd.indices.get(1)).toBe(1);

    const second = await hd.send({
      cashaddr: miner.getDepositAddress(),
      value: 3001n,
    });
    expect(coinsOf(hd, second).spent).toEqual([change]);
    await expectReflected(hd, second);
    expect(hd.indices.get(1)).toBe(2);

    // and sendMax right after a send takes the last change
    const all = await hd.sendMax(miner.getDepositAddress());
    expect(coinsOf(hd, all).spent).toEqual(coinsOf(hd, second).own);
    expect(await hd.getUtxos()).toEqual([]);
    expect(await hd.getBalance()).toBe(0n);
    await hd.stop();
  });

  test("an HD wallet's token sends and operations follow each other", async () => {
    const { miner, hd } = await fundedHd(100000n);
    const bob = await RegTestWallet.newRandom();

    const genesis = await hd.tokenGenesis({ amount: 100n });
    await expectReflected(hd, genesis);
    const category = genesis.categories[0];
    expect(await getTokenBalance(hd, category)).toBe(100n);

    // token change and BCH change, both to the next change address
    const first = await hd.send(
      new TokenSendRequest({ cashaddr: bob.tokenaddr, category, amount: 10n }),
    );
    await expectReflected(hd, first);
    expect(await getTokenBalance(hd, category)).toBe(90n);
    const second = await hd.send(
      new TokenSendRequest({ cashaddr: bob.tokenaddr, category, amount: 11n }),
    );
    await expectReflected(hd, second);
    expect(await getTokenBalance(hd, category)).toBe(79n);
    const burn = await hd.tokenBurn({ category, amount: 9n });
    await expectReflected(hd, burn);
    expect(await getTokenBalance(hd, category)).toBe(70n);

    const bch = await hd.send({
      cashaddr: miner.getDepositAddress(),
      value: 5000n,
    });
    await expectReflected(hd, bch);
    expect(await getTokenBalance(bob, category)).toBe(21n);
    await hd.stop();
  });

  test("a single-address wallet's sends follow each other while blocks confirm its coins", async () => {
    const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
    const bob = await RegTestWallet.newRandom();
    await miner.send({ cashaddr: bob.cashaddr, value: 50000n });
    await waitForBalance(bob, 50000n);

    for (let i = 0; i < 4; i++) {
      // the block's status of bob's address, without the send, arrives while it is being made
      await mine({ cashaddr: miner.getDepositAddress(), blocks: 1 });
      const response = await bob.send({
        cashaddr: miner.getDepositAddress(),
        value: 1000n + BigInt(i),
      });
      await expectReflected(bob, response);
    }
    await bob.stop();
  });
});

// mem-cash answers in the same tick; these slow its status notifications or utxo lookups down to
// the pace of a real server, where the status of a send can arrive after the broadcast returns
describe.skipIf(!useMock)("a send on a slow server", () => {
  let provider: MockNetworkProvider;
  let lookupDelay: number;
  let notifyDelay: number;

  beforeEach(async () => {
    provider = new MockNetworkProvider();
    await provider.connect();
    lookupDelay = 0;
    notifyDelay = 0;
    const getUtxos = provider.getUtxos.bind(provider);
    // the server's answer as at the request, received later
    provider.getUtxos = async (...args) => {
      const ms = lookupDelay;
      const utxos = await getUtxos(...args);
      await delay(ms);
      return utxos;
    };
    const subscribeToAddress = provider.subscribeToAddress.bind(provider);
    provider.subscribeToAddress = (address, callback) =>
      subscribeToAddress(address, (data) => {
        setTimeout(() => callback(data), notifyDelay);
      });
  });

  async function fund(address: string, satoshis: bigint) {
    await provider.addUtxo(address, {
      ...randomUtxo({ vout: 0, satoshis }),
      height: 100,
    });
  }

  test("an HD wallet's returns once its change is read", async () => {
    const hd = await RegTestHDWallet.newRandom("", { provider });
    const bob = await RegTestWallet.newRandom("", { provider });
    await hd["watchPromise"];
    await fund(hd.getDepositAddress(0), 20000n);
    await hd["waitForUpdate"]({ indices: { 0: 1 } });

    lookupDelay = 200;
    const first = await hd.send({ cashaddr: bob.cashaddr, value: 3000n });
    await expectReflected(hd, first);
    const second = await hd.send({ cashaddr: bob.cashaddr, value: 3001n });
    expect(coinsOf(hd, second).spent).toEqual(coinsOf(hd, first).own);
    await hd.stop();
    await bob.stop();
  });

  test("a single-address wallet's is not ended by a status without it", async () => {
    const alice = await RegTestWallet.newRandom("", { provider });
    const bob = await RegTestWallet.newRandom("", { provider });
    await fund(alice.cashaddr, 20000n);
    await fund(bob.cashaddr, 20000n);
    await waitForBalance(alice, 20000n);
    await waitForBalance(bob, 20000n);

    // as a block's on the real chain: bob's status for a payment is read from the server just
    // before bob's send is broadcast, the answer arriving after it and before the send's status
    lookupDelay = 300;
    const sendRawTransaction = provider.sendRawTransaction.bind(provider);
    let payment: Promise<unknown> | undefined;
    provider.sendRawTransaction = async (...args) => {
      if (!payment) {
        payment = alice.send({ cashaddr: bob.cashaddr, value: 5000n });
        await delay(100);
        notifyDelay = 400;
      }
      return sendRawTransaction(...args);
    };
    const response = await bob.send({ cashaddr: alice.cashaddr, value: 1000n });
    await expectReflected(bob, response);
    await payment;
    await alice.stop();
    await bob.stop();
  });

  test("a send whose status never comes returns after a bounded wait", async () => {
    const bob = await RegTestWallet.newRandom("", { provider });
    await fund(bob.cashaddr, 20000n);
    await waitForBalance(bob, 20000n);

    // the wallet's lookups stall, the broadcast still goes through
    lookupDelay = 60_000;
    const start = Date.now();
    const response = await bob.send({ cashaddr: bob.cashaddr, value: 1000n });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(await provider.getRawTransaction(response.txId)).toMatch(
      /^[0-9a-f]+$/,
    );
    expect(bob["watchCallbacks"]).toEqual([]);
    await bob.stop();
  }, 30_000);
});
