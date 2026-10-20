import {
  CashAddressNetworkPrefix,
  CashAddressType,
  decodeHdPublicKey,
  deriveHdPathRelative,
  encodeCashAddress,
} from "@bitauth/libauth";

import { hash160 } from "./hash160.js";

/**
 * Derive cashsaddresses given the `xpub`, relative `path` and count of addresses to derive.
 *
 * @param xpub the parent xpubkey from which to derive child public keys, for example `xpub6ByHsPNSQXTWZ7PLESMY2FufyYWtLXagSUpMQq7Un96SiThZH2iJB1X7pwviH1WtKVeDP6K8d6xxFzzoaFzF3s8BKCZx8oEDdDkNnp4owAZ` at `m/44'/145'/0'`
 * @param path relative path from the parent xpubkey to derive the child public keys, for example "0/0" for receiving addresses or "1/0" for change addresses
 * @param count amount of child public keys to derive
 * @returns array of cashaddresses derived from the xpubkey
 */
export function getAddrsByXpubKey(
  xpub: string,
  path: string,
  count: number,
): Array<string> {
  const pathComponents = path.split("/");
  const result: Array<string> = [];

  const start = parseInt(pathComponents.pop()!);
  const end = start + count;
  for (let curr = start; curr < end; curr++) {
    const childPath = [...pathComponents, curr].join("/");
    result.push(derivePublicNodeCashaddr(xpub, childPath));
  }
  return result;
}

export function derivePublicNodeCashaddr(xpub: string, path?: string): string {
  const publicParent = decodeHdPublicKey(xpub);

  if (typeof publicParent === "string") {
    throw new Error(publicParent);
  }
  const prefix = (
    publicParent.network === "mainnet" ? "bitcoincash" : "bchtest"
  ) as CashAddressNetworkPrefix;

  let cashaddr;
  if (typeof path === "string") {
    const childNode = deriveHdPathRelative(publicParent.node, path);
    if (typeof childNode === "string") {
      throw new Error(childNode);
    } else {
      const childPkh = hash160(childNode.publicKey);
      cashaddr = encodeCashAddress({
        prefix,
        type: CashAddressType.p2pkh,
        payload: childPkh,
      }).address;
    }
  }
  return cashaddr;
}
