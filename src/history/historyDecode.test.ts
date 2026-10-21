import { disconnectProviders, initProviders } from "#test/providers.js";
import { RegTestWallet } from "../wallet/Wif.js";

const decodes = vi.hoisted(() => ({ count: 0 }));
vi.mock("@bitauth/libauth", async (importOriginal) => {
  const libauth = await importOriginal<typeof import("@bitauth/libauth")>();
  return {
    ...libauth,
    decodeTransaction: (
      ...args: Parameters<typeof libauth.decodeTransaction>
    ) => {
      decodes.count++;
      return libauth.decodeTransaction(...args);
    },
  };
});

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

test("a history decodes each transaction once, its own parents included", async () => {
  const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
  const wallet = await RegTestWallet.newRandom();
  await miner.send({ cashaddr: wallet.cashaddr!, value: 100000n });
  // each spends the change of the one before, a parent within the history
  for (let i = 0; i < 3; i++) {
    await wallet.send({ cashaddr: miner.cashaddr!, value: 10000n });
  }

  decodes.count = 0;
  const history = await wallet.getHistory();

  const hashes = new Set(history.map((item) => item.hash));
  const otherParents = new Set(
    history
      .flatMap((item) => item.inputs)
      .map((input) => input.outpointTransactionHash)
      .filter((hash) => !hashes.has(hash!)),
  );
  expect(history.length).toBe(4);
  expect(decodes.count).toBe(history.length + otherParents.size);
});
