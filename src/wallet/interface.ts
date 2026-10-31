import { Network, Utxo } from "../interface.js";
import type ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";

export interface SendRequestOptionsI {
  utxoIds?: string[] | Utxo[];
  /** coins no input of the spend may use, e.g. reserved ones; ids not in the wallet are ignored, malformed ones throw */
  excludeUtxoIds?: string[] | Utxo[];
  /**
   * addresses whose coins no input of the spend may use, those arriving after the caller looked
   * included; a token-aware and a plain address are one, one that does not decode throws
   */
  excludeAddresses?: string[];
  /**
   * the only token coins the spend may use, e.g. an identity's UTXO; the pool's other token coins
   * are left out, its BCH coins are not. Ids not in the wallet are ignored, malformed ones throw
   */
  tokenUtxoIds?: string[] | Utxo[];
  /**
   * @internal tokenGenesis, tokenMint and tokenBurn set it: false is no token input matching and
   * no token change, the outputs are the requests as given. The check that the transaction burns
   * no token stays on
   */
  checkTokenQuantities?: boolean; // true
  /**
   * which token rules pick the inputs; tokenGenesis, tokenMint and tokenBurn set it themselves. A
   * hand-built mint passes "mint", so that its token requests do not look for matching token inputs
   */
  tokenOperation?: "send" | "genesis" | "mint" | "burn";
  ensureUtxos?: Utxo[]; // ensure these inputs will be consumed in the transaction; they must be in the spend's pool
  /**
   * sendMax and getMaxAmountToSend only: also spend each token coin of the pool whose satoshis
   * above its dust limit pay for more than spending it and recreating its output. Its tokens come
   * back unchanged, holding their dust limit, on a change address of their own; a token coin in
   * ensureUtxos is swept whether it pays or not. Off by default: it puts token coins in a BCH
   * send, linking them to its recipient. Without it a max send leaves token coins out, those in
   * utxoIds too, and refuses one in ensureUtxos
   */
  sweepTokenSatoshis?: boolean;
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
  /**
   * The network of the wallet, mainnet when left out: a test network (`"testnet"` for chipnet) or
   * one added with registerNetwork (`HDWallet.fromId(id, { network: "testnet" })`).
   */
  network?: Network;
}
