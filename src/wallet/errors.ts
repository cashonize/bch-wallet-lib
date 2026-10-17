import type { NetworkType } from "../enum.js";
import type { NFTCapability } from "../interface.js";

/**
 * Thrown when the wallet's coins (or the `utxoIds` given) cannot cover a send: too little BCH,
 * or no token coins, or too few, for a category. Tell it apart with `instanceof` rather than by
 * its message; `asset` says which of the two ran short, `category` which token.
 */
export class InsufficientFundsError extends Error {
  readonly asset: "bch" | "token";
  readonly category?: string;

  constructor(
    message: string,
    { asset, category }: { asset: "bch" | "token"; category?: string },
  ) {
    super(message);
    this.name = "InsufficientFundsError";
    this.asset = asset;
    this.category = category;
  }
}

/**
 * Thrown before anything is built or fetched when a request's token data cannot go on chain as
 * given: a malformed category or commitment, a fungible amount out of range, or a token output
 * with neither fungible tokens nor an NFT. `field` names the request field (`category`,
 * `nft.commitment`, `amount`, `nft`), `value` holds what was given. Also thrown, before the
 * transaction is built, for a send option that cannot be honored, with `field` naming the
 * option: an `excludeUtxoIds` entry that is not a `txid:vout` outpoint, or a token coin in
 * `ensureUtxos` of a max send (`value` the offending `txid:vout`).
 */
export class InvalidRequestError extends Error {
  readonly field: string;
  readonly value: unknown;

  constructor(
    message: string,
    { field, value }: { field: string; value: unknown },
  ) {
    super(message);
    this.name = "InvalidRequestError";
    this.field = field;
    this.value = value;
  }
}

export type UtxoNotAvailableReason =
  | "excluded"
  | "not-in-utxoIds"
  | "not-in-tokenUtxoIds"
  | "not-found";

/**
 * Thrown before anything is built when a coin a spend is told to use, in `ensureUtxos`, is not
 * in its pool: the wallet's current coins, narrowed to `utxoIds` when given, their token coins
 * narrowed to `tokenUtxoIds` when given, minus `excludeUtxoIds`. `utxoId` is the coin's
 * `txid:vout`, the txid lowercased; `reason` says why it is not in the pool.
 * Also thrown, with `reason` `"not-found"`, for a `utxoIds` coin the wallet does not hold.
 */
export class UtxoNotAvailableError extends Error {
  readonly utxoId: string;
  readonly reason: UtxoNotAvailableReason;

  constructor(
    message: string,
    { utxoId, reason }: { utxoId: string; reason: UtxoNotAvailableReason },
  ) {
    super(message);
    this.name = "UtxoNotAvailableError";
    this.utxoId = utxoId;
    this.reason = reason;
  }
}

/**
 * Thrown before a built transaction is signed when its outputs destroy tokens its inputs carry
 * and the operation did not ask for that: a regression in the change or the coin choice would
 * otherwise burn them. `category` is the token category; `amount` the fungible tokens missing
 * from the outputs (0n when an NFT is), `nft` the NFT missing from them.
 */
export class TokenBurnError extends Error {
  readonly category: string;
  readonly amount: bigint;
  readonly nft?: { capability: NFTCapability; commitment: string };

  constructor(
    message: string,
    {
      category,
      amount,
      nft,
    }: {
      category: string;
      amount: bigint;
      nft?: { capability: NFTCapability; commitment: string };
    },
  ) {
    super(message);
    this.name = "TokenBurnError";
    this.category = category;
    this.amount = amount;
    this.nft = nft;
  }
}

/**
 * Thrown when a walletId cannot be read: its network part is missing or not the wallet's
 * network (`reason` `"network"`; for `saveNamedWallet`, not the network of the database), its type part is unknown or not one this class loads
 * (`"kind"`), its key, address or name is missing (`"missing-value"`), or a `named:` id names
 * another database than the network's (`"database"`). `kind` is the id's type part (`"wif"`,
 * `"seed"`, `"hd"`, `"watch"`, `"privkey"` or `"named"`) when it is one of those, and undefined
 * otherwise: no other part of the id is ever quoted, as it may be the key.
 */
export class InvalidWalletIdError extends Error {
  readonly kind?: string;
  readonly reason: "network" | "kind" | "missing-value" | "database";

  constructor(
    message: string,
    {
      kind,
      reason,
    }: {
      kind?: string;
      reason: "network" | "kind" | "missing-value" | "database";
    },
  ) {
    super(message);
    this.name = "InvalidWalletIdError";
    this.kind = kind;
    this.reason = reason;
  }
}

/**
 * Thrown when a WIF cannot be used: it is not a WIF (`reason` `"malformed"`), it encodes an
 * uncompressed key, whose funds are on an address this library does not derive
 * (`"uncompressed"`), or it is for another network than the wallet's (`"network"`). `network`
 * is the WIF's own network when it could be read. The WIF is never in the error.
 */
export class InvalidWifError extends Error {
  readonly reason: "malformed" | "uncompressed" | "network";
  readonly network?: NetworkType.Mainnet | NetworkType.Testnet;

  constructor(
    message: string,
    {
      reason,
      network,
    }: {
      reason: "malformed" | "uncompressed" | "network";
      network?: NetworkType.Mainnet | NetworkType.Testnet;
    },
  ) {
    super(message);
    this.name = "InvalidWifError";
    this.reason = reason;
    this.network = network;
  }
}
