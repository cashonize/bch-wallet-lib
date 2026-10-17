import { ExchangeRate } from "./ExchangeRate.js";
import { liveTests } from "#test/live.js";

describe("ExchangeRate in browser", () => {
  test.skipIf(!liveTests)("Should get exchange rate in usd", async () => {
    const rate = await ExchangeRate.get("usd");
    expect(rate).toBeGreaterThan(0);
  });
});
