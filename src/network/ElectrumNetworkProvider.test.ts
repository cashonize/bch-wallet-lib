import { countRequests } from "#test/countRequests.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { Config } from "../config.js";
import { RegTestWallet } from "../wallet/Wif.js";
import ElectrumNetworkProvider from "./ElectrumNetworkProvider.js";
import { createMockProvider } from "./MockNetworkProvider.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

const address = "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0";

describe("getRawTransactions and getHeaders fan out bounded", () => {
  test("at most 10 requests in flight by default, one request per item", async () => {
    const provider = await createMockProvider();
    await provider.connect();
    const txIds = await provider.mine(address, 25);
    const heights = Array.from({ length: 25 }, (_, i) => 201 + i);

    const { counts, restore } = countRequests(provider);
    const transactions = await provider.getRawTransactions(txIds);
    const headers = await provider.getHeaders(heights);
    restore();

    expect(counts.byMethod).toEqual({
      "blockchain.transaction.get": 25,
      "blockchain.header.get": 25,
    });
    expect(counts.maxInFlight).toBe(10);
    expect([...transactions.keys()]).toEqual(txIds);
    expect(
      [...transactions.values()].every((hex) => /^[0-9a-f]+$/.test(hex)),
    ).toBe(true);
    expect([...headers.keys()]).toEqual(heights);
    expect([...headers.values()].map((header) => header.height)).toEqual(
      heights,
    );
  });

  test("the concurrency option overrides the default", async () => {
    const provider = await createMockProvider();
    await provider.connect();
    const txIds = await provider.mine(address, 12);

    const { counts, restore } = countRequests(provider);
    await provider.getRawTransactions(txIds, { concurrency: 3 });
    const maxForTransactions = counts.maxInFlight;
    counts.maxInFlight = 0;
    await provider.getHeaders([201, 202, 203, 204, 205], { concurrency: 1 });
    restore();

    expect(maxForTransactions).toBe(3);
    expect(counts.maxInFlight).toBe(1);
  });

  test("one missing transaction still rejects the whole call", async () => {
    const provider = await createMockProvider();
    await provider.connect();
    const txIds = await provider.mine(address, 3);

    await expect(
      provider.getRawTransactions([...txIds, "ab".repeat(32)]),
    ).rejects.toThrow();
  });
});

test("the input values of a transaction are read at most 10 at a time", async () => {
  const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
  const bob = await RegTestWallet.newRandom();
  for (let i = 0; i < 12; i++) {
    await miner.send({ cashaddr: bob.cashaddr!, value: 3000n });
  }
  // 12 inputs from 12 transactions
  const { txId } = await bob.sendMax(miner.getDepositAddress());

  const provider = bob.provider as ElectrumNetworkProvider;
  const { counts, restore } = countRequests(provider);
  const transaction = await provider.getRawTransactionObject(txId!, true);
  restore();

  expect(transaction.vin.length).toBe(12);
  expect(transaction.vin.every((input) => input.value === 3000 / 1e8)).toBe(
    true,
  );
  expect(counts.byMethod["blockchain.transaction.get"]).toBe(13);
  expect(counts.maxInFlight).toBe(10);
});

test("a transaction the server answers with another one is refused, rather than cached under the txid asked for", async () => {
  const provider = await createMockProvider();
  await provider.connect();
  const [asked, other] = await provider.mine(address, 2);
  // performRequest is protected; the test wraps it from outside
  const target = provider as unknown as {
    performRequest(method: string, params: unknown[]): Promise<unknown>;
  };
  const performRequest = target.performRequest.bind(provider);
  target.performRequest = (method, params) => {
    if (method === "blockchain.transaction.get" && params[0] === asked) {
      return performRequest(method, [other, ...params.slice(1)]);
    }
    return performRequest(method, params);
  };

  const refusal = `with transaction ${other}`;
  await expect(provider.getRawTransaction(asked)).rejects.toThrow(refusal);
  await expect(provider.getRawTransactions([asked])).rejects.toThrow(refusal);
  await expect(provider.getRawTransactionObject(asked)).rejects.toThrow(
    refusal,
  );
  expect(await provider.getRawTransaction(other)).toMatch(/^[0-9a-f]+$/);
});

// a provider's first call can be a cache read, before any request has opened the cache
test("reads the cache before its first request without failing", async () => {
  const cacheSetting = Config.UseIndexedDBCache;
  Config.UseIndexedDBCache = true;
  try {
    const provider = await createMockProvider();
    const headers = await provider.getHeaders([1]);
    expect(headers.get(1)?.height).toBe(1);
  } finally {
    Config.UseIndexedDBCache = cacheSetting;
  }
});
