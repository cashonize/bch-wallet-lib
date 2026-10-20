export interface WalletDbEntryI {
  name: string;
  wallet: string;
}

export interface ExchangeRateI {
  symbol: string;
  rate: number;
  ttl: number;
  // the rate source it was fetched from (see ExchangeRate.ts); absent in rates cached by mainnet-js 3
  source?: string;
}
