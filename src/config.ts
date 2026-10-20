export class Config {
  // enforces all token-related methods to specify tokenaddr as recepient and change cashaddr
  static EnforceCashTokenReceiptAddresses = false;
  static DefaultParentDerivationPath = "m/44'/145'/0'";
  // caches raw transactions, headers and HD wallet records in IndexedDB; without it raw
  // transactions and headers are not cached, and an HD wallet keeps its cache in memory
  static UseIndexedDBCache = false;
  // fee rate for every send in satoshis per byte, at least 1; when unset the server's blockchain.relayfee is used
  static RelayFeePerByte: number | undefined = undefined;

  // custom exchange rate function
  public static GetExchangeRateFn:
    | ((symbol: string) => Promise<number>)
    | undefined = undefined;
}
