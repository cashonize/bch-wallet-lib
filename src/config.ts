export class Config {
  // enforces all token-related methods to specify tokenaddr as recepient and change cashaddr
  static EnforceCashTokenReceiptAddresses = false;
  static DefaultParentDerivationPath = "m/44'/0'/0'";
  static DefaultIpfsGateway = "https://dweb.link/ipfs/";
  // default currency for balance and rate conversions
  static DefaultCurrency = "usd";
  // caches the raw transactions in browser's local storage instead of memory
  static UseLocalStorageCache = false;
  // caches the raw transactions in browser's indexedDB instead of memory
  static UseIndexedDBCache = false;
  // caches the raw transactions in browser's memory
  static UseMemoryCache = false;
  // fee rate for every send in satoshis per byte, at least 1; when unset the server's blockchain.relayfee is used
  static RelayFeePerByte: number | undefined = undefined;
  // the highest fee rate in satoshis per byte a server's blockchain.relayfee can set
  static MaxRelayFeePerByte = 10;

  public static setIpfsGateway(ipfsGateway: string) {
    this.DefaultIpfsGateway = ipfsGateway;
  }

  // custom exchange rate function
  public static GetExchangeRateFn:
    | ((symbol: string) => Promise<number>)
    | undefined = undefined;
}
