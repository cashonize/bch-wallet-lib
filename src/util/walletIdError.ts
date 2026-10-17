import { NetworkType } from "../enum.js";
import { WalletTypeEnum } from "../wallet/enum.js";
import { InvalidWalletIdError } from "../wallet/errors.js";

// The type part of a walletId, when it is one: a bare key puts itself in that slot
export function walletIdKind(
  walletType: string | undefined,
): string | undefined {
  if (Object.values<string | undefined>(WalletTypeEnum).includes(walletType)) {
    return walletType;
  }
  return undefined;
}

// A walletId missing its network part ("wif:<key>") puts the key in the network slot,
// so only a known network name is quoted back.
export function networkPrefixError(
  walletType: string | undefined,
  networkGiven: string | undefined,
  network: string,
): InvalidWalletIdError {
  const kind = walletIdKind(walletType);
  if (Object.values<string | undefined>(NetworkType).includes(networkGiven)) {
    return new InvalidWalletIdError(
      `Network prefix ${networkGiven} to a ${network} wallet`,
      { kind, reason: "network" },
    );
  }
  return new InvalidWalletIdError(
    `Unknown network prefix to a ${network} wallet`,
    { kind, reason: "network" },
  );
}

// fromId called with an id of a type the class does not load
export function walletTypeError(
  walletType: string,
  expected: string,
): InvalidWalletIdError {
  return new InvalidWalletIdError(
    `fromId called on a ${walletType} wallet, expected a ${expected} wallet`,
    { kind: walletIdKind(walletType), reason: "kind" },
  );
}
