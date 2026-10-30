export enum NetworkType {
  Mainnet = "mainnet",
  Testnet = "testnet",
  Regtest = "regtest",
}

const literal = <L extends string>(l: L): L => l;

export const UnitEnum = {
  BCH: literal("bch"),
  USD: literal("usd"),
  SAT: literal("sat"),
};
export type UnitEnum = (typeof UnitEnum)[keyof typeof UnitEnum];
