import { Utxo } from "../interface.js";
import type ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";

export interface SendRequestOptionsI {
  utxoIds?: string[] | Utxo[];
  /** coins no input of the spend may use, e.g. reserved ones; ids not in the wallet are ignored, malformed ones throw */
  excludeUtxoIds?: string[] | Utxo[];
  checkTokenQuantities?: boolean; // true
  /**
   * which token rules pick the inputs; tokenGenesis, tokenMint and tokenBurn set it themselves. A
   * hand-built mint passes "mint" with checkTokenQuantities: false, so that its token requests do
   * not look for matching token inputs
   */
  tokenOperation?: "send" | "genesis" | "mint" | "burn";
  ensureUtxos?: Utxo[]; // ensure these inputs will be consumed in the transaction; they must be in the spend's pool
  broadcast?: boolean; // true
}

export type CancelFn = () => Promise<void>;

/** Options of the wallet factories (fromId, named, newRandom, …), fixed for the wallet's life */
export interface WalletFactoryOptions {
  /**
   * The electrum provider the wallet talks to from the start: its first subscription and an HD
   * wallet's address discovery are made on it, and the network's global provider is never created
   * or used. Without it the wallet uses the global provider. Its network must be the wallet's.
   */
  provider?: ElectrumNetworkProvider;
}
