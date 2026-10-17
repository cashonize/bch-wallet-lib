import { countRequests } from "#test/countRequests.js";
import { createMockProvider } from "./MockNetworkProvider.js";

const address = "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0";

describe("getRawTransactions and getHeaders fan out bounded", () => {
  test("at most 10 requests in flight by default, one request per item", async () => {
    const provider = await createMockProvider();
    await provider.ready();
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
    await provider.ready();
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
    await provider.ready();
    const txIds = await provider.mine(address, 3);

    await expect(
      provider.getRawTransactions([...txIds, "ab".repeat(32)]),
    ).rejects.toThrow();
  });
});
