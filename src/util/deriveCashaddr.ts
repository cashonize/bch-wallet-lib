import {
  CashAddressNetworkPrefix,
  CashAddressType,
  DecodedCashAddress,
  decodeCashAddress,
  encodeCashAddress,
  secp256k1,
} from "@bitauth/libauth";
import { hash160 } from "./hash160.js";

export function deriveCashaddr(
  privateKey: Uint8Array,
  networkPrefix: CashAddressNetworkPrefix,
): string {
  let publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === "string") {
    throw new Error(publicKey);
  }
  let pkh = hash160(publicKey);
  return encodeCashAddress({
    prefix: networkPrefix,
    type: CashAddressType.p2pkh,
    payload: pkh,
  }).address;
}

function decodeAddress(address: string): DecodedCashAddress {
  const result = decodeCashAddress(address);
  if (typeof result === "string") {
    throw new Error(result);
  }
  return result;
}

export function toCashaddr(address: string): string {
  if (address.indexOf(":q") > 0 || address.indexOf(":p") > 0) {
    return address;
  }

  const result = decodeAddress(address);

  return encodeCashAddress({
    prefix: result.prefix as CashAddressNetworkPrefix,
    type: result.type.replace("WithTokens", "") as CashAddressType,
    payload: result.payload,
  }).address;
}

export function toTokenaddr(address: string): string {
  if (address.indexOf(":z") > 0 || address.indexOf(":r") > 0) {
    return address;
  }

  const result = decodeAddress(address);

  return encodeCashAddress({
    prefix: result.prefix as CashAddressNetworkPrefix,
    type: (result.type.replace("WithTokens", "") +
      "WithTokens") as CashAddressType,
    payload: result.payload,
  }).address;
}

export function isTokenaddr(address: string): boolean {
  const result = decodeAddress(address);

  return result.type.endsWith("WithTokens");
}

export function checkTokenaddr(cashaddr: string, enforce: boolean) {
  if (enforce && !isTokenaddr(cashaddr)) {
    throw new Error("Error trying to send to a non-tokenaware cash address");
  }
}
