import { ExchangeRate } from "../rate/ExchangeRate.js";
import { convert } from "./convert.js";
import { liveTests } from "#test/live.js";

beforeAll(() => {
  // Clear exchange rate cache to ensure consistent rates across conversions
  globalThis.RATE = {};
});

test.skipIf(!liveTests)("Should get price sat in usd", async () => {
  let { rate } = await ExchangeRate.getQuote("usd");
  let usd = await convert(100000000, "sat", "usd");
  expect(Math.round(rate)).toBeLessThan(usd + 1);
  expect(Math.round(rate)).toBeGreaterThan(usd - 1);
});

test.skipIf(!liveTests)("Should get of bch in usd", async () => {
  let { rate } = await ExchangeRate.getQuote("usd");
  let usd = await convert(1, "bch", "usd");
  expect(Math.round(rate)).toBeLessThan(usd + 1);
  expect(Math.round(rate)).toBeGreaterThan(usd - 1);
});

test.skipIf(!liveTests)("Should get usd value in fixed format", async () => {
  let usd = await convert(1, "bch", "usd");
  expect(usd.toFixed(2)).toMatch(/^\d+\.\d+?$/);
});

test.skipIf(!liveTests)("Should get price in usd in bch", async () => {
  let { rate } = await ExchangeRate.getQuote("usd");
  let unity = await convert(rate, "usd", "bch");
  expect(unity).toBeLessThan(1.01);
  expect(unity).toBeGreaterThan(0.99);
});

test.skipIf(!liveTests)("Should convert in full loop", async () => {
  let usd = await convert(1, "bch", "usd");
  let sat = await convert(usd, "USD", "sat");
  let bch = await convert(sat, "sat", "BCH");
  expect(bch).toBeLessThan(1.01);
  expect(bch).toBeGreaterThan(0.99);
});

test("Should convert all the BCH from sat to bch", async () => {
  let bch = await convert(21000000 * 100000000, "sat", "BCH");
  expect(bch).toBe(21000000);
});

test.skipIf(!liveTests)("Should convert BCH to EUR", async () => {
  let eur = await convert(1, "BCH", "EUR");
  expect(eur).toBeGreaterThan(0);
});
