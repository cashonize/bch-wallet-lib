import { setupFetchMock } from "#test/fetch.js";
import { Config } from "../config.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { convert } from "../util/convert.js";
import { ExchangeRate } from "./ExchangeRate.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe("Exchange rate tests", () => {
  test("Get price in usd", async () => {
    setupFetchMock("https://markets.api.bitcoin.com/live/bitcoin", {
      data: {
        BCH: 1337.42,
      },
    });

    let rate = await ExchangeRate.get("usd", false);
    expect(rate).toBe(1337.42);
  });

  test("Test other currencies", async () => {
    const eurRate = await ExchangeRate.get("eur");
    expect(eurRate).toBeGreaterThan(0);
  });

  test("Test non-existing currency", async () => {
    await expect(ExchangeRate.get("xyz")).rejects.toThrow();
  });

  test("Test custom exchange rate function", async () => {
    Config.GetExchangeRateFn = async (symbol: string): Promise<number> => {
      if (symbol === "usd") {
        return 5555.55;
      }
      throw new Error("Unsupported currency");
    };

    const usdRate = await ExchangeRate.get("usd", false);
    expect(usdRate).toBe(5555.55);

    await expect(ExchangeRate.get("eur", false)).rejects.toThrow(
      "Unsupported currency",
    );

    Config.GetExchangeRateFn = undefined;
  });

  test("Cache the first fetched rate", async () => {
    let fetches = 0;
    Config.GetExchangeRateFn = async (): Promise<number> => {
      fetches++;
      return 400;
    };
    delete globalThis.RATE;

    try {
      expect(await convert(1, "bch", "usd")).toBe(400);
      expect(await convert(1, "bch", "usd")).toBe(400);
      expect(fetches).toBe(1);
    } finally {
      Config.GetExchangeRateFn = undefined;
      delete globalThis.RATE;
    }
  });
});
