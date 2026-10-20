import { NetworkEnum } from "../enum.js";
import { Utxo } from "../interface.js";
import { ElectrumRawTransaction } from "../network/interface.js";

export interface SendRequestOptionsI {
  utxoIds?: string[] | Utxo[];
  changeAddress?: string;
  queryBalance?: boolean;
  checkTokenQuantities?: boolean; // true
  tokenOperation?: "send" | "genesis" | "mint" | "burn"; // undefined. internal use only
  ensureUtxos?: Utxo[]; // ensure these inputs will be consumed in the transaction
  broadcast?: boolean; // true
}

export type CancelFn = () => Promise<void>;
