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
 * `nft.commitment`, `amount`, `nft`), `value` holds what was given.
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
