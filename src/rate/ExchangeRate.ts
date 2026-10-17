import { Config } from "../config.js";
import { EXCHANGE_RATE_TTL } from "../constant.js";
import ExchangeRateProvider from "../db/ExchangeRateProvider.js";
import { ExchangeRateI } from "../db/interface.js";
import {
  getRuntimePlatform,
  RuntimePlatform,
} from "../util/getRuntimePlatform.js";

export interface ExchangeRateOptions {
  // when the fetch fails, return the last cached rate of the current source, however old, instead of throwing
  staleOnError?: boolean;
}

export interface ExchangeRateQuote {
  symbol: string;
  rate: number;
  // ms since the epoch, when the rate was fetched
  fetchedAt: number;
  // true when the fetch failed and this is the last known rate
  stale: boolean;
}

export class ExchangeRate {
  /**
   * The BCH rate in `symbol` (e.g. "usd"), from `Config.GetExchangeRateFn` or the built-in
   * sources, cached for its TTL; tells when the rate was fetched and whether it is stale.
   */
  static async getQuote(
    symbol: string,
    options: ExchangeRateOptions = {},
  ): Promise<ExchangeRateQuote> {
    return await getQuote(platformCache(), symbol, options);
  }
}

// The rate behind the unit conversions (convert, amountInSatoshi); not part of the entry
export async function getRate(symbol: string): Promise<number> {
  const quote = await getQuote(platformCache(), symbol, {});
  return quote.rate;
}

interface RateCache {
  read(symbol: string): Promise<ExchangeRateI | undefined>;
  write(entry: ExchangeRateI): Promise<void>;
}

const localStorageCache: RateCache = {
  read: (symbol) => new ExchangeRateProvider().getRate(symbol),
  write: async (entry) => {
    await new ExchangeRateProvider().setRate(entry);
  },
};

const globalScopeCache: RateCache = {
  read: async (symbol) => globalThis.RATE?.[symbol],
  write: async (entry) => {
    globalThis.RATE ??= {};
    globalThis.RATE[entry.symbol] = entry;
  },
};

// a browser whose localStorage throws (e.g. blocked site data) caches in memory
const browserCache: RateCache = {
  read: async (symbol) => {
    try {
      return await localStorageCache.read(symbol);
    } catch {
      return await globalScopeCache.read(symbol);
    }
  },
  write: async (entry) => {
    try {
      await localStorageCache.write(entry);
    } catch {
      await globalScopeCache.write(entry);
    }
  },
};

function platformCache(): RateCache {
  if (getRuntimePlatform() === RuntimePlatform.browser) {
    return browserCache;
  }
  return globalScopeCache;
}

// Cached rates are tagged with the rate source they came from. Until
// Config.GetExchangeRateFn changes in this process, every cached rate counts
// (the persisted ones were written by an earlier run, whose source is unknown);
// after a change, only rates fetched from the current source in this process.
const processId = Math.random().toString(36).slice(2);
const UNSEEN = Symbol("unseen");
let rateSource: typeof Config.GetExchangeRateFn | typeof UNSEEN = UNSEEN;
let rateSourceChanges = 0;

function currentSourceTag(): string {
  const current = Config.GetExchangeRateFn;
  if (rateSource !== UNSEEN && rateSource !== current) {
    rateSourceChanges++;
  }
  rateSource = current;
  return `${processId}:${rateSourceChanges}`;
}

function isUsable(
  entry: ExchangeRateI | undefined,
  sourceTag: string,
): entry is ExchangeRateI {
  if (
    typeof entry?.rate !== "number" ||
    !Number.isFinite(entry.rate) ||
    typeof entry.ttl !== "number"
  ) {
    return false;
  }
  return rateSourceChanges === 0 || entry.source === sourceTag;
}

async function getQuote(
  cache: RateCache,
  symbol: string,
  options: ExchangeRateOptions,
): Promise<ExchangeRateQuote> {
  const sourceTag = currentSourceTag();
  const source = Config.GetExchangeRateFn;
  const cached = await cache.read(symbol);
  if (isUsable(cached, sourceTag) && cached.ttl > Date.now()) {
    return toQuote(symbol, cached, false);
  }

  let freshRate: number;
  try {
    freshRate = await fetchRate(source, symbol);
  } catch (error) {
    if (options.staleOnError) {
      const cached = await cache.read(symbol).catch(() => undefined);
      // not when the source changed while it was fetched
      const unchanged = currentSourceTag() === sourceTag;
      if (unchanged && isUsable(cached, sourceTag)) {
        return toQuote(symbol, cached, true);
      }
    }
    throw error;
  }
  const entry = { symbol, rate: freshRate, ttl: getTtl(), source: sourceTag };
  // a rate of a source switched away from while it was fetched is not cached
  if (currentSourceTag() === sourceTag) {
    // a rate that cannot be cached (e.g. storage full) is still returned
    await cache.write(entry).catch(() => {});
  }
  return toQuote(symbol, entry, false);
}

function toQuote(
  symbol: string,
  entry: ExchangeRateI,
  stale: boolean,
): ExchangeRateQuote {
  return {
    symbol,
    rate: entry.rate,
    fetchedAt: entry.ttl - EXCHANGE_RATE_TTL,
    stale,
  };
}

function getTtl() {
  return Math.trunc(Date.now() + EXCHANGE_RATE_TTL);
}

async function fetchRate(
  source: typeof Config.GetExchangeRateFn,
  symbol: string,
): Promise<number> {
  if (source) {
    return await source(symbol);
  }

  if (symbol.length > 0) {
    symbol = symbol.toLocaleLowerCase();
  }

  if (symbol === "usd") {
    try {
      const response = await fetch(
        "https://markets.api.bitcoin.com/live/bitcoin",
      );
      const data = await response.json();
      return data["data"]["BCH"];
    } catch {}
  }

  const response = await fetch("https://bitpay.com/rates/BCH");
  const data = (await response.json()) as {
    data: { code: string; rate: number }[];
  };
  const rates = data.data.reduce(
    (acc, rate) => ({ ...acc, [rate.code.toLocaleLowerCase()]: rate.rate }),
    {},
  );
  if (symbol in rates) {
    return rates[symbol];
  }

  throw Error(`Currency '${symbol}' is not supported.`);
}
