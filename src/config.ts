export class Config {
  // enforces all token-related methods to specify tokenaddr as recepient and change cashaddr
  static EnforceCashTokenReceiptAddresses = false;
  static DefaultParentDerivationPath = "m/44'/0'/0'";
  // default currency for balance and rate conversions
  static DefaultCurrency = "usd";
  // caches the raw transactions in browser's indexedDB instead of memory
  static UseIndexedDBCache = false;

  // custom exchange rate function
  public static GetExchangeRateFn:
    | ((symbol: string) => Promise<number>)
    | undefined = undefined;
}
