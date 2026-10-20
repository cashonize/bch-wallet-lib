import { ExchangeRateI } from "./interface.js";

export default class ExchangeRateProvider {
  /*
   *   Exchange Rate functions
   */

  public async getRate(symbol: string): Promise<ExchangeRateI | undefined> {
    const valueString = localStorage.getItem(`rate-${symbol}`);
    if (valueString) {
      return JSON.parse(valueString) as ExchangeRateI;
    }

    return undefined;
  }

  public async setRate(entry: ExchangeRateI): Promise<boolean> {
    localStorage.setItem(`rate-${entry.symbol}`, JSON.stringify(entry));
    return true;
  }
}
