import { NetworkEnum } from "../enum.js";
import { Utxo } from "../interface.js";
import { ElectrumRawTransaction } from "../network/interface.js";

export interface WalletInfoI {
  cashaddr?: string;
  tokenaddr?: string;
  isTestnet?: boolean;
  name?: string;
  network: NetworkEnum;
  seed?: string;
  derivationPath?: string;
  parentDerivationPath?: string;
  parentXPubKey?: string;
  publicKey?: string;
  publicKeyHash?: string;
  privateKey?: string;
  privateKeyWif?: string;
  walletId: string;
  walletDbEntry: string;
}

export interface SendRequestOptionsI {
  utxoIds?: string[] | Utxo[];
  changeAddress?: string;
  queryBalance?: boolean;
  awaitTransactionPropagation?: boolean;
  checkTokenQuantities?: boolean; // true
  tokenOperation?: "send" | "genesis" | "mint" | "burn"; // undefined. internal use only
  ensureUtxos?: Utxo[]; // ensure these inputs will be consumed in the transaction
  broadcast?: boolean; // true
}

export interface MnemonicI {
  seed: string;
  derivationPath: string;
  parentDerivationPath: string;
}

export interface WalletI {
  // Accessors
  getDepositAddress(): string;
  getTokenDepositAddress(): string;
  // getSeed(): MnemonicI;
  // getNetworkProvider(network: NetworkType): any;
  // generate(): Promise<this>;

  // Serialization
  toString(): string;
  toDbString(): string;

  // Static constructors
  // fromId(walletId: string): Promise<this>;
  // fromSeed(mnemonic: string, derivationPath?: string): Promise<this>;
  // newRandom(name: string, dbName?: string): Promise<this>;
  // watchOnly(address: string): Promise<this>;
  // named(name: string, dbName?: string, forceNew?: boolean): Promise<this>;
  // namedExists(name: string, dbName?: string): Promise<boolean>;

  // Funds
  getBalance(): Promise<any>;
  getMaxAmountToSend(params?: any): Promise<any>;
  send(requests: any, options?: any): Promise<any>;
  sendMax(address: string, options?: any): Promise<any>;
}

export type CancelFn = () => Promise<void>;
