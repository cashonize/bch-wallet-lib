import { bchParam } from "../chain.js";
import { ExchangeRate } from "../rate/ExchangeRate.js";
import { amountInSatoshi } from "./amountInSatoshi.js";
import { liveTests } from "#test/live.js";

test("Get price of Bch, BCH, bch in sat", async () => {
  let rate = await amountInSatoshi(1, "Bch");
  expect(rate).toBe(bchParam.subUnits);
  rate = await amountInSatoshi(1, "BCH");
  expect(rate).toBe(bchParam.subUnits);
  rate = await amountInSatoshi(1, "bch");
  expect(rate).toBe(bchParam.subUnits);
});

test("Get price of sat(s)", async () => {
  let rate = await amountInSatoshi(1, "sat");
  expect(rate).toBe(1n);
});

test.skipIf(!liveTests)("Get price of USD, Usd, usd", async () => {
  // Clear exchange rate cache so the rate inside amountInSatoshi
  // fetches a fresh rate consistent with what we read here
  globalThis.RATE = {};
  let { rate: usdRate } = await ExchangeRate.getQuote("usd");
  let rate = await amountInSatoshi(usdRate - 10, "USD");
  expect(rate).toBeLessThan(bchParam.subUnits);
  rate = await amountInSatoshi(usdRate - 10, "Usd");
  expect(rate).toBeLessThan(bchParam.subUnits);
  rate = await amountInSatoshi(usdRate - 10, "usd");
  expect(rate).toBeLessThan(bchParam.subUnits);
});
