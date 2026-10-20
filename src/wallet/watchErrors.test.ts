import { randomUtxo } from "@paryonusd/mem-cash";
import { MockInstance } from "vitest";
import { Network } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { BaseWallet } from "./Base.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

// A watch callback's throw or rejection, and a failed read a watch makes for it, goes to
// console.error; never an unhandled rejection
let provider: MockNetworkProvider;
let refuseAddress: boolean;
let unhandled: unknown[];
let consoleError: MockInstance;
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(async () => {
  provider = new MockNetworkProvider();
  await provider.connect();
  refuseAddress = false;
  const subscribeToAddress = provider.subscribeToAddress.bind(provider);
  provider.subscribeToAddress = async (...args) => {
    if (refuseAddress) throw new Error("subscription refused");
    return subscribeToAddress(...args);
  };
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  setGlobalProvider(Network.REGTEST, provider);
});
afterEach(async () => {
  removeGlobalProvider(Network.REGTEST);
  // unhandled rejections are reported once the microtasks have run
  await delay(20);
  process.off("unhandledRejection", onUnhandled);
  consoleError.mockRestore();
  expect(unhandled).toEqual([]);
});

async function fund(address: string, satoshis: bigint) {
  await provider.addUtxo(address, {
    ...randomUtxo({ vout: 0, satoshis }),
    height: 100,
  });
}

const boom = new Error("callback failed");

describe("a watch callback that fails", () => {
  test("goes to console.error, once per failure, and the watch goes on", async () => {
    const wallet = await RegTestWallet.newRandom();
    const balances: bigint[] = [];
    await wallet.watchBalance(async (balance) => {
      balances.push(balance);
      throw boom;
    });

    await fund(wallet.cashaddr, 1_000n);
    await delay(100);
    await fund(wallet.cashaddr, 2_000n);
    await delay(100);
    expect(balances).toEqual([1_000n, 3_000n]);
    expect(consoleError.mock.calls).toEqual([[boom], [boom]]);
    await wallet.stop();
  });

  test("goes to console.error from a balance and a status watch", async () => {
    const wallet = await RegTestWallet.newRandom();
    await wallet.watchBalance(() => {
      throw boom;
    });
    await wallet["watchStatus"](async () => {
      throw boom;
    });

    await fund(wallet.cashaddr, 1_000n);
    await delay(100);
    expect(consoleError.mock.calls).toEqual([[boom], [boom]]);
    await wallet.stop();
  });

  test("does not keep a single-address wallet's other watchers from being called", async () => {
    const wallet = await RegTestWallet.newRandom();
    await wallet["watchStatus"](async () => {
      throw boom;
    });
    const statuses: (string | null)[] = [];
    await wallet["watchStatus"]((status) => {
      statuses.push(status);
    });

    await fund(wallet.cashaddr, 1_000n);
    await delay(100);
    expect(consoleError.mock.calls).toEqual([[boom]]);
    expect(statuses).toHaveLength(1);
    await wallet.stop();
  });

  test("goes to console.error from the base status watch", async () => {
    const wallet = await RegTestWallet.newRandom();
    // the provider-backed watch that the wallet classes override
    await BaseWallet.prototype["watchStatus"].call(wallet, async () => {
      throw boom;
    });
    // it fires on subscribing
    await delay(20);
    expect(consoleError.mock.calls).toEqual([[boom]]);
    await wallet.stop();
  });

  test("goes to console.error from an HD wallet's watch", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchBalance(async () => {
      throw boom;
    });

    await fund(wallet.getDepositAddress(0), 1_000n);
    await delay(300);
    expect(consoleError.mock.calls).toEqual([[boom]]);
    await wallet.stop();
  });

  test("goes to console.error for each new transaction", async () => {
    await provider.seedAlice();
    const wallet = await RegTestWallet.newRandom();
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    await wallet["watchTransactionHashes"](() => {
      throw boom;
    });
    await wallet["watchTransactions"](async () => {
      throw boom;
    });

    await alice.send([
      { cashaddr: wallet.cashaddr, value: 1_000n },
      { cashaddr: wallet.cashaddr, value: 1_000n },
    ]);
    await alice.send({ cashaddr: wallet.cashaddr, value: 1_000n });
    await delay(300);
    // each watch reports each of the two transactions once
    expect(consoleError.mock.calls).toEqual([[boom], [boom], [boom], [boom]]);
    await alice.stop();
    await wallet.stop();
  });

  test("goes to console.error from a block watch", async () => {
    const wallet = await RegTestWallet.newRandom();
    await wallet.watchBlocks(async () => {
      throw boom;
    }, true);

    await provider.mine(wallet.cashaddr, 1);
    await delay(100);
    expect(consoleError.mock.calls).toEqual([[boom]]);
    await wallet.stop();
  });

  test("of a provider subscription goes to console.error", async () => {
    const wallet = await RegTestWallet.newRandom();
    await wallet.stop();
    const cancel = await provider.subscribeToAddress(
      wallet.cashaddr,
      async () => {
        throw boom;
      },
    );
    await delay(20);
    expect(consoleError.mock.calls).toEqual([[boom]]);
    await cancel();
  });
});

describe("a read that a watch makes and that fails", () => {
  // the used address moves the HD wallet's gap, and the extension cannot subscribe, so its reads
  // reject until discovery runs again
  async function failGapExtension(wallet: RegTestHDWallet) {
    refuseAddress = true;
    await fund(wallet.getDepositAddress(15), 1_000n);
    await delay(300);
  }

  test("goes to console.error", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    const balances: bigint[] = [];
    await wallet.watchBalance((balance) => balances.push(balance));

    await failGapExtension(wallet);
    expect(balances).toEqual([]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0].message).toBe("subscription refused");
    refuseAddress = false;
    await wallet.stop();
  });
});
