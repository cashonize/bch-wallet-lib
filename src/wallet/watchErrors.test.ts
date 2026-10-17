import { randomUtxo } from "@paryonusd/mem-cash";
import { MockInstance } from "vitest";
import { Network } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { delay } from "../util/delay.js";
import { BaseWallet } from "./Base.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

// A watch callback's throw or rejection, and a failed read a watch makes for it, goes to the
// watch's onError, or to console.error without one; never an unhandled rejection
let provider: MockNetworkProvider;
let refuseAddress: boolean;
let unhandled: unknown[];
let consoleError: MockInstance;
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(async () => {
  provider = new MockNetworkProvider();
  await provider.ready();
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
  test("goes to onError, once per failure, and the watch goes on", async () => {
    const wallet = await RegTestWallet.newRandom();
    const errors: unknown[] = [];
    const balances: bigint[] = [];
    await wallet.watchBalance(
      async (balance) => {
        balances.push(balance);
        throw boom;
      },
      { onError: (error) => errors.push(error) },
    );

    await fund(wallet.cashaddr, 1_000n);
    await delay(100);
    await fund(wallet.cashaddr, 2_000n);
    await delay(100);
    expect(balances).toEqual([1_000n, 3_000n]);
    expect(errors).toEqual([boom, boom]);
    expect(consoleError).not.toHaveBeenCalled();
    await wallet.stop();
  });

  test("goes to console.error without onError", async () => {
    const wallet = await RegTestWallet.newRandom();
    await wallet.watchBalance(() => {
      throw boom;
    });
    await wallet.watchStatus(async () => {
      throw boom;
    });

    await fund(wallet.cashaddr, 1_000n);
    await delay(100);
    expect(consoleError.mock.calls).toEqual([[boom], [boom]]);
    await wallet.stop();
  });

  test("does not keep a single-address wallet's other watchers from being called", async () => {
    const wallet = await RegTestWallet.newRandom();
    const errors: unknown[] = [];
    await wallet.watchStatus(
      async () => {
        throw boom;
      },
      { onError: (error) => errors.push(error) },
    );
    const statuses: (string | null)[] = [];
    await wallet.watchStatus((status) => {
      statuses.push(status);
    });

    await fund(wallet.cashaddr, 1_000n);
    await delay(100);
    expect(errors).toEqual([boom]);
    expect(statuses).toHaveLength(1);
    await wallet.stop();
  });

  test("goes to onError from the base status watch", async () => {
    const wallet = await RegTestWallet.newRandom();
    const errors: unknown[] = [];
    // the provider-backed watch that the wallet classes override
    await BaseWallet.prototype.watchStatus.call(
      wallet,
      async () => {
        throw boom;
      },
      { onError: (error) => errors.push(error) },
    );
    // it fires on subscribing
    await delay(20);
    expect(errors).toEqual([boom]);
    await wallet.stop();
  });

  test("goes to onError from an HD wallet's watch", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    const errors: unknown[] = [];
    await wallet.watchBalance(
      async () => {
        throw boom;
      },
      { onError: (error) => errors.push(error) },
    );

    await fund(wallet.getDepositAddress(0), 1_000n);
    await delay(300);
    expect(errors).toEqual([boom]);
    await wallet.stop();
  });

  test("goes to onError for each new transaction", async () => {
    await provider.seedAlice();
    const wallet = await RegTestWallet.newRandom();
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    await wallet.watchTransactionHashes(
      () => {
        throw boom;
      },
      { onError },
    );
    await wallet.watchTransactions(
      async () => {
        throw boom;
      },
      { onError },
    );

    await alice.send([
      { cashaddr: wallet.cashaddr, value: 1_000n },
      { cashaddr: wallet.cashaddr, value: 1_000n },
    ]);
    await alice.send({ cashaddr: wallet.cashaddr, value: 1_000n });
    await delay(300);
    // each watch reports each of the two transactions once
    expect(errors).toEqual([boom, boom, boom, boom]);
    await alice.stop();
    await wallet.stop();
  });

  test("goes to onError from a block watch", async () => {
    const wallet = await RegTestWallet.newRandom();
    const errors: unknown[] = [];
    await wallet.watchBlocks(
      async () => {
        throw boom;
      },
      true,
      { onError: (error) => errors.push(error) },
    );

    await provider.mine(wallet.cashaddr, 1);
    await delay(100);
    expect(errors).toEqual([boom]);
    await wallet.stop();
  });

  test("an onError that throws goes to console.error", async () => {
    const wallet = await RegTestWallet.newRandom();
    const handlerError = new Error("onError failed");
    await wallet.watchBalance(
      () => {
        throw boom;
      },
      {
        onError: () => {
          throw handlerError;
        },
      },
    );

    await fund(wallet.cashaddr, 1_000n);
    await delay(100);
    expect(consoleError.mock.calls).toEqual([[handlerError]]);
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

  test("goes to the watch's onError", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    const errors: unknown[] = [];
    const balances: bigint[] = [];
    await wallet.watchBalance((balance) => balances.push(balance), {
      onError: (error) => errors.push(error),
    });

    await failGapExtension(wallet);
    expect(balances).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("subscription refused");
    refuseAddress = false;
    await wallet.stop();
  });

  test("rejects waitForBalance and ends its watch", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const waiting = wallet.waitForBalance(5_000n);
    // a watch that does not fail keeps it waiting
    await fund(wallet.getDepositAddress(0), 1_000n);
    await delay(300);

    const rejected = expect(waiting).rejects.toThrow("subscription refused");
    await failGapExtension(wallet);
    await rejected;
    refuseAddress = false;
    expect(wallet["walletWatchCallbacks"]).toHaveLength(0);
    await wallet.stop();
  });

  test("rejects waitForTokenBalance", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const waiting = wallet.waitForTokenBalance("11".repeat(32), 1n);
    const rejected = expect(waiting).rejects.toThrow("subscription refused");
    await failGapExtension(wallet);
    await rejected;
    refuseAddress = false;
    await wallet.stop();
  });

  test("rejects waitForTransaction", async () => {
    const wallet = await RegTestHDWallet.newRandom();
    await wallet.watchPromise;
    const waiting = wallet.waitForTransaction();
    const rejected = expect(waiting).rejects.toThrow("subscription refused");
    await failGapExtension(wallet);
    await rejected;
    refuseAddress = false;
    await wallet.stop();
  });
});
