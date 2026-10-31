import { Network } from "../interface.js";
import { getNetworkProvider } from "../network/default.js";
import { RegTestWallet } from "../wallet/Wif.js";
import { disconnectProviders, initProviders } from "#test/providers.js";

const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;

beforeAll(async () => {
  await initProviders();
});

afterAll(async () => {
  await disconnectProviders();
});

describe("Rpc tests", () => {
  test("get utxos", async () => {
    const provider = getNetworkProvider(Network.REGTEST);
    expect(
      await provider.getUtxos(
        "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0",
      ),
    ).not.toHaveLength(0);
  });

  test("subcribe to address", async () => {
    const provider = getNetworkProvider(Network.REGTEST);
    try {
      await provider.subscribeToAddress(
        "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0",
        async (data) => {
          expect(data).not.toBe("");
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e: any) {
      console.log(e, e.message, e.stack);
    }
  });

  test("subcribe to muliple addresses bug", async () => {
    const provider = getNetworkProvider(Network.REGTEST);

    try {
      await provider.subscribeToAddress(
        "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0",
        async (data) => {
          // console.log("First", data);
          expect(data).not.toBe("");
        },
      );

      await provider.subscribeToAddress(
        "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0",
        async (data) => {
          // console.log("Second", data);
          expect(data).not.toBe("");
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e: any) {
      console.log(e, e.message, e.stack);
    }
  });

  test("Watch wallet coins", async () => {
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();

    let result = false;
    const cancel = await aliceWallet.watchUtxos(({ removed }) => {
      if (removed.length) result = true;
    });
    // Trigger a real status change on Alice's address
    await aliceWallet.send([{ cashaddr: bobWallet.cashaddr!, value: 1000n }]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(result).toBe(true);
    await cancel();
  });
});
