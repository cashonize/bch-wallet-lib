import { NetworkType } from "../enum.js";

// A walletId missing its network part ("wif:<key>") puts the key in the network slot,
// so only a known network name is quoted back.
export function networkPrefixError(
  networkGiven: string | undefined,
  network: string,
): Error {
  if (Object.values<string | undefined>(NetworkType).includes(networkGiven)) {
    return Error(`Network prefix ${networkGiven} to a ${network} wallet`);
  }
  return Error(`Unknown network prefix to a ${network} wallet`);
}
