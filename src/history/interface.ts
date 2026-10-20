import { TokenI } from "../interface.js";

export interface InOutput {
  address: string;
  value: number;
  token?: TokenI;
  /** Inputs only, except coinbase: the spent outpoint's transaction hash (display order) and index */
  outpointTransactionHash?: string;
  outpointIndex?: number;
  /** Hex; set on every output and on every input except coinbase */
  lockingBytecode?: string;
}

export interface TransactionHistoryItem {
  inputs: InOutput[];
  outputs: InOutput[];
  blockHeight: number;
  timestamp?: number;
  hash: string;
  size: number;
  fee: number;
  balance: number;
  valueChange: number;
  tokenAmountChanges: {
    category: string;
    amount: bigint;
    nftAmount: bigint;
  }[];
}
