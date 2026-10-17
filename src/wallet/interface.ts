import { NetworkEnum } from "../enum.js";
import { Utxo } from "../interface.js";
import { ElectrumRawTransaction } from "../network/interface.js";
import type { TokenBurnAllowance } from "../transaction/tokenConservation.js";
import { WalletTypeEnum } from "./enum.js";

export interface WalletRequestI {
  name?: string;
  network?: string;
  type?: WalletTypeEnum;
  platform?: string;
  walletId?: string;
}

export interface WalletResponseI {
  name: string;
  cashaddr?: string;
  address?: string;
  walletId: string;
  network?: NetworkEnum;
  wif?: string;
  privkey?: string;
  seed?: string;
  derivationPath?: string;
  parentDerivationPath?: string;
}

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
  /** coins no input of the spend may use, e.g. reserved ones; ids not in the wallet are ignored, malformed ones throw */
  excludeUtxoIds?: string[] | Utxo[];
  queryBalance?: boolean;
  awaitTransactionPropagation?: boolean;
  checkTokenQuantities?: boolean; // true
  tokenOperation?: "send" | "genesis" | "mint" | "burn"; // undefined. internal use only
  tokenBurns?: TokenBurnAllowance; // undefined. internal use only: what a token operation may burn
  ensureUtxos?: Utxo[]; // ensure these inputs will be consumed in the transaction; they must be in the spend's pool
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

export interface WaitForTransactionOptions {
  getTransactionInfo?: boolean;
  getBalance?: boolean;
  txHash?: string;
}

export interface WaitForTransactionResponse {
  transactionInfo?: ElectrumRawTransaction;
  balance?: bigint;
}

export type CancelFn = () => Promise<void>;

/** Options of a watch, whose callback may be async: its rejection is handled as a throw. */
export interface WatchOptions {
  /**
   * Receives each error of the watch's callback, and of a read the watch makes for it, in place
   * of the default console.error; the watch goes on.
   */
  onError?: (error: unknown) => void;
}
