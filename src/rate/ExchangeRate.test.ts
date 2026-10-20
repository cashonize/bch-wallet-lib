import { setupFetchMock } from "#test/fetch.js";
import { Config } from "../config.js";
import { EXCHANGE_RATE_TTL } from "../constant.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { convert } from "../util/convert.js";
import { ExchangeRate } from "./ExchangeRate.js";
import { liveTests } from "#test/live.js";

// The module as a browser loads it, caching in localStorage (in Node it caches in the global scope),
// with a Config of its own
async function inBrowser() {
  vi.resetModules();
  vi.doMock("../util/getRuntimePlatform.js", async (importOriginal) => {
    const actual =
      await importOriginal<typeof import("../util/getRuntimePlatform.js")>();
    return {
      ...actual,
      getRuntimePlatform: () => actual.RuntimePlatform.browser,
    };
  });
  try {
    const { Config } = await import("../config.js");
    const { ExchangeRate } = await import("./ExchangeRate.js");
    return { Config, ExchangeRate };
  } finally {
    vi.doUnmock("../util/getRuntimePlatform.js");
  }
}

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
    delete globalThis.RATE;

    try {
      const { rate } = await ExchangeRate.getQuote("usd");
      expect(rate).toBe(1337.42);
    } finally {
      delete globalThis.RATE;
    }
  });

  test.skipIf(!liveTests)("Test other currencies", async () => {
    const { rate } = await ExchangeRate.getQuote("eur");
    expect(rate).toBeGreaterThan(0);
  });

  test.skipIf(!liveTests)("Test non-existing currency", async () => {
    await expect(ExchangeRate.getQuote("xyz")).rejects.toThrow();
  });

  test("Test custom exchange rate function", async () => {
    Config.GetExchangeRateFn = async (symbol: string): Promise<number> => {
      if (symbol === "usd") {
        return 5555.55;
      }
      throw new Error("Unsupported currency");
    };
    delete globalThis.RATE;

    try {
      const { rate } = await ExchangeRate.getQuote("usd");
      expect(rate).toBe(5555.55);

      await expect(ExchangeRate.getQuote("eur")).rejects.toThrow(
        "Unsupported currency",
      );
    } finally {
      Config.GetExchangeRateFn = undefined;
      delete globalThis.RATE;
    }
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
    const browser = await inBrowser();

    try {
      for (const variant of [{ Config, ExchangeRate }, browser]) {
        const get = async (symbol: string) =>
          (await variant.ExchangeRate.getQuote(symbol)).rate;
        fetchesA = 0;
        fetchesB = 0;
        variant.Config.GetExchangeRateFn = sourceA;
        expect(await get("usd")).toBe(400);
        expect(await get("usd")).toBe(400);
        expect(fetchesA).toBe(1);

        variant.Config.GetExchangeRateFn = sourceB;
        expect(await get("usd")).toBe(500);
        expect(fetchesB).toBe(1);

        // switching back does not revive the rate cached before the switch
        variant.Config.GetExchangeRateFn = sourceA;
        expect(await get("usd")).toBe(400);
        expect(fetchesA).toBe(2);
        variant.Config.GetExchangeRateFn = undefined;
      }
      // the browser's rate went to localStorage
      expect(JSON.parse(localStorage.getItem("rate-usd")!)).toMatchObject({
        symbol: "usd",
        rate: 400,
      });
    } finally {
      Config.GetExchangeRateFn = undefined;
      browser.Config.GetExchangeRateFn = undefined;
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
      const pendingA = ExchangeRate.getQuote("usd");
      await vi.waitFor(() => expect(resolveA).toBeDefined());
      let fetchesB = 0;
      Config.GetExchangeRateFn = async (): Promise<number> => {
        fetchesB++;
        return 500;
      };
      resolveA!(400);
      expect((await pendingA).rate).toBe(400);

      expect((await ExchangeRate.getQuote("usd")).rate).toBe(500);
      expect(fetchesB).toBe(1);
    } finally {
      Config.GetExchangeRateFn = undefined;
      delete globalThis.RATE;
    }
  });

  test("A rate cached by mainnet-js 3 is used until the rate source changes", async () => {
    const { Config, ExchangeRate } = await inBrowser();
    const get = async (symbol: string) =>
      (await ExchangeRate.getQuote(symbol)).rate;
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
      expect(await get("usd")).toBe(400);
      expect(fetches).toBe(0);

      // after a switch, the source of an untagged rate is unknown
      Config.GetExchangeRateFn = async () => 600;
      expect(await get("usd")).toBe(600);
      Config.GetExchangeRateFn = source;
      localStorage.setItem(
        "rate-usd",
        JSON.stringify({ symbol: "usd", rate: 400, ttl: Date.now() + 100000 }),
      );
      expect(await get("usd")).toBe(500);
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
  test("getQuote falls back to the last known rate only with staleOnError", async () => {
    let failing = false;
    const source = async (): Promise<number> => {
      if (failing) {
        throw new Error("rate source down");
      }
      return 400;
    };
    Config.GetExchangeRateFn = source;
    delete globalThis.RATE;

    try {
      const before = Date.now();
      const fresh = await ExchangeRate.getQuote("usd");
      expect(fresh).toMatchObject({ symbol: "usd", rate: 400, stale: false });
      expect(fresh.fetchedAt).toBeGreaterThanOrEqual(before);
      expect(fresh.fetchedAt).toBeLessThanOrEqual(Date.now());

      // a cached rate within its TTL is served fresh, without a fetch
      failing = true;
      expect(await ExchangeRate.getQuote("usd")).toEqual(fresh);

      // past the TTL, the fetch fails
      globalThis.RATE.usd.ttl = Date.now() - 1;
      const fetchedAt = globalThis.RATE.usd.ttl - EXCHANGE_RATE_TTL;
      await expect(ExchangeRate.getQuote("usd")).rejects.toThrow(
        "rate source down",
      );
      expect(
        await ExchangeRate.getQuote("usd", { staleOnError: true }),
      ).toEqual({ symbol: "usd", rate: 400, fetchedAt, stale: true });

      // no last known rate for the symbol: the error is thrown
      await expect(
        ExchangeRate.getQuote("eur", { staleOnError: true }),
      ).rejects.toThrow("rate source down");

      // nor is the last rate of a source switched away from
      Config.GetExchangeRateFn = async () => {
        throw new Error("other source down");
      };
      await expect(
        ExchangeRate.getQuote("usd", { staleOnError: true }),
      ).rejects.toThrow("other source down");
    } finally {
      Config.GetExchangeRateFn = undefined;
      delete globalThis.RATE;
    }
  });
  test("a NaN, 0 or negative rate from the source is refused and not cached", async () => {
    let answer: unknown = 400;
    Config.GetExchangeRateFn = async () => answer as number;
    delete globalThis.RATE;

    try {
      for (const bad of [NaN, 0, -1, Infinity, "400", undefined]) {
        answer = bad;
        await expect(ExchangeRate.getQuote("usd")).rejects.toThrow(
          "no usable rate",
        );
        expect(globalThis.RATE?.usd).toBeUndefined();
      }

      // with a last known rate, staleOnError falls back to it
      answer = 400;
      await ExchangeRate.getQuote("usd");
      globalThis.RATE.usd.ttl = Date.now() - 1;
      answer = 0;
      expect(
        await ExchangeRate.getQuote("usd", { staleOnError: true }),
      ).toMatchObject({ rate: 400, stale: true });
      expect(globalThis.RATE.usd.rate).toBe(400);
      await expect(ExchangeRate.getQuote("usd")).rejects.toThrow(
        "no usable rate",
      );

      // nor is a 0 rate in the cache served
      globalThis.RATE.usd = {
        ...globalThis.RATE.usd,
        rate: 0,
        ttl: Date.now() + 100000,
      };
      answer = 500;
      expect((await ExchangeRate.getQuote("usd")).rate).toBe(500);
    } finally {
      Config.GetExchangeRateFn = undefined;
      delete globalThis.RATE;
    }
  });
});
