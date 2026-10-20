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
