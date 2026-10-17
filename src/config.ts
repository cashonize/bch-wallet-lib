export class Config {
  // enforces all token-related methods to specify tokenaddr as recepient and change cashaddr
  static EnforceCashTokenReceiptAddresses = false;
  static DefaultParentDerivationPath = "m/44'/0'/0'";
  // caches the raw transactions in browser's indexedDB instead of memory
  static UseIndexedDBCache = false;
  // fee rate for every send in satoshis per byte, at least 1; when unset the server's blockchain.relayfee is used
  static RelayFeePerByte: number | undefined = undefined;
  // the highest blockchain.relayfee in satoshis per byte the wallet trusts; a server rate above it is
  // ignored and sends pay 1 sat/byte
  static MaxRelayFeePerByte = 10;

  // custom exchange rate function
  public static GetExchangeRateFn:
    | ((symbol: string) => Promise<number>)
    | undefined = undefined;
}
