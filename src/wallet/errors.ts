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
