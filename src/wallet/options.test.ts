import { disconnectProviders, initProviders } from "#test/providers.js";
import { SendRequestOptionsI, WaitForTransactionOptions } from "./interface.js";
import { TokenSendRequest } from "./model.js";
import { RegTestWallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

// Reusing an options object, e.g. for a retry, must not carry the previous inputs forward
describe("the caller's options object is left as it was", () => {
  test("sendMax", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    await alice.send([[bob.cashaddr, 10_000n]]);

    const options: SendRequestOptionsI = { broadcast: false };
    await bob.sendMax(alice.cashaddr, options);
    expect(options).toEqual({ broadcast: false });
  });

  test("a token send", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const genesis = await alice.tokenGenesis({ amount: 100n });
    const category = genesis.categories![0];

    const options: SendRequestOptionsI = { broadcast: false };
    await alice.send(
      new TokenSendRequest({ cashaddr: bob.tokenaddr, amount: 10n, category }),
      options,
    );
    expect(options).toEqual({ broadcast: false });
  });

  test("waitForTransaction", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();
    const { txId } = await alice.send([[bob.cashaddr, 10_000n]]);

    const options: WaitForTransactionOptions = { txHash: txId };
    const response = await bob.waitForTransaction(options);
    expect(response.transactionInfo?.txid).toBe(txId);
    expect(options).toEqual({ txHash: txId });
  });
});
