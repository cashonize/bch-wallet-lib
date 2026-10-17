import {
  Base58AddressFormatVersion,
  decodeBase58AddressFormat,
} from "@bitauth/libauth";
import { NetworkType } from "../enum.js";

// The messages never quote the WIF: apps show and log them, and the WIF is the key.
// Regtest takes WIFs of either version byte, as it always did.
export function decodeWif(wif: string, network: NetworkType): Uint8Array {
  const decoded = decodeBase58AddressFormat(wif);
  if (typeof decoded === "string") {
    throw Error("Invalid WIF: not a valid base58check string");
  }

  let wifNetwork: NetworkType;
  if (decoded.version === Base58AddressFormatVersion.wif) {
    wifNetwork = NetworkType.Mainnet;
  } else if (decoded.version === Base58AddressFormatVersion.wifTestnet) {
    wifNetwork = NetworkType.Testnet;
  } else {
    throw Error("Invalid WIF: unknown version byte");
  }

  if (network !== NetworkType.Regtest && wifNetwork !== network) {
    throw Error(`WIF is for ${wifNetwork}, expected ${network}`);
  }

  // an uncompressed key's funds are on the address of its uncompressed public key,
  // which this wallet does not derive or sign for
  if (decoded.payload.length === 32) {
    throw Error("Uncompressed WIF private keys are not supported");
  }
  if (decoded.payload.length !== 33 || decoded.payload[32] !== 0x01) {
    throw Error("Invalid WIF: unexpected payload length");
  }

  return decoded.payload.slice(0, 32);
}
