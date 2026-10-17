import { Utxo } from "../interface.js";

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

/** Options of a watch, whose callback may be async: its rejection is handled as a throw. */
export interface WatchOptions {
  /**
   * Receives each error of the watch's callback, and of a read the watch makes for it, in place
   * of the default console.error; the watch goes on.
   */
  onError?: (error: unknown) => void;
}
