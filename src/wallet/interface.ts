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
