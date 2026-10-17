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

  test("Switching the rate source refetches instead of serving the old source's rate", async () => {
    let fetchesA = 0;
    let fetchesB = 0;
    const sourceA = async (): Promise<number> => {
      fetchesA++;
      return 400;
    };
    const sourceB = async (): Promise<number> => {
      fetchesB++;
      return 500;
    };
    delete globalThis.RATE;
    localStorage.removeItem("rate-usd");

    try {
      for (const get of [
        (symbol: string) => ExchangeRate.get(symbol),
        (symbol: string) => ExchangeRate.getRateFromLocalStorage(symbol),
      ]) {
        fetchesA = 0;
        fetchesB = 0;
        Config.GetExchangeRateFn = sourceA;
        expect(await get("usd")).toBe(400);
        expect(await get("usd")).toBe(400);
        expect(fetchesA).toBe(1);

        Config.GetExchangeRateFn = sourceB;
        expect(await get("usd")).toBe(500);
        expect(fetchesB).toBe(1);

        // switching back does not revive the rate cached before the switch
        Config.GetExchangeRateFn = sourceA;
        expect(await get("usd")).toBe(400);
        expect(fetchesA).toBe(2);
      }
    } finally {
      Config.GetExchangeRateFn = undefined;
      delete globalThis.RATE;
      localStorage.removeItem("rate-usd");
    }
  });

  test("A rate still being fetched when the source switches is not cached", async () => {
    let resolveA: ((rate: number) => void) | undefined;
    Config.GetExchangeRateFn = () =>
      new Promise<number>((resolve) => (resolveA = resolve));
    delete globalThis.RATE;

    try {
      const pendingA = ExchangeRate.get("usd");
      await vi.waitFor(() => expect(resolveA).toBeDefined());
      let fetchesB = 0;
      Config.GetExchangeRateFn = async (): Promise<number> => {
        fetchesB++;
        return 500;
      };
      resolveA!(400);
      expect(await pendingA).toBe(400);

      expect(await ExchangeRate.get("usd")).toBe(500);
      expect(fetchesB).toBe(1);
    } finally {
      Config.GetExchangeRateFn = undefined;
      delete globalThis.RATE;
    }
  });

  test("A rate cached by mainnet-js 3 is used until the rate source changes", async () => {
    vi.resetModules();
    const { Config } = await import("../config.js");
    const { ExchangeRate } = await import("./ExchangeRate.js");
    let fetches = 0;
    const source = async (): Promise<number> => {
      fetches++;
      return 500;
    };
    Config.GetExchangeRateFn = source;
    localStorage.setItem(
      "rate-usd",
      JSON.stringify({ symbol: "usd", rate: 400, ttl: Date.now() + 100000 }),
    );

    try {
      expect(await ExchangeRate.getRateFromLocalStorage("usd")).toBe(400);
      expect(fetches).toBe(0);

      // after a switch, the source of an untagged rate is unknown
      Config.GetExchangeRateFn = async () => 600;
      expect(await ExchangeRate.getRateFromLocalStorage("usd")).toBe(600);
      Config.GetExchangeRateFn = source;
      localStorage.setItem(
        "rate-usd",
        JSON.stringify({ symbol: "usd", rate: 400, ttl: Date.now() + 100000 }),
      );
      expect(await ExchangeRate.getRateFromLocalStorage("usd")).toBe(500);
      expect(fetches).toBe(1);
      expect(JSON.parse(localStorage.getItem("rate-usd")!)).toMatchObject({
        symbol: "usd",
        rate: 500,
      });
    } finally {
      Config.GetExchangeRateFn = undefined;
      localStorage.removeItem("rate-usd");
    }
  });
});
