import {
  Base58AddressFormatVersion,
  decodeBase58AddressFormat,
} from "@bitauth/libauth";
import { NetworkType } from "../enum.js";
import type { Network } from "../interface.js";
import { networkConfig } from "../network/registry.js";
import { InvalidWifError } from "../wallet/errors.js";

/**
 * Decodes a WIF without judging it: which network it is for, whether it encodes a compressed
 * key, and the 32-byte private key. Testnet WIFs are also those of chipnet, regtest and the test networks an app registers.
 *
 * @throws {InvalidWifError} with `reason` `"malformed"` when it is not a WIF.
 */
export function decodeWif(wif: string): {
  network: NetworkType.Mainnet | NetworkType.Testnet;
  compressed: boolean;
  privateKey: Uint8Array;
} {
  // The messages never quote the WIF: apps show and log them, and the WIF is the key.
  const decoded = decodeBase58AddressFormat(wif);
  if (typeof decoded === "string") {
    throw new InvalidWifError("Invalid WIF: not a valid base58check string", {
      reason: "malformed",
    });
  }

  let network: NetworkType.Mainnet | NetworkType.Testnet;
  if (decoded.version === Base58AddressFormatVersion.wif) {
    network = NetworkType.Mainnet;
  } else if (decoded.version === Base58AddressFormatVersion.wifTestnet) {
    network = NetworkType.Testnet;
  } else {
    throw new InvalidWifError("Invalid WIF: unknown version byte", {
      reason: "malformed",
    });
  }

  if (decoded.payload.length === 32) {
    return { network, compressed: false, privateKey: decoded.payload };
  }
  if (decoded.payload.length !== 33 || decoded.payload[32] !== 0x01) {
    throw new InvalidWifError("Invalid WIF: unexpected payload length", {
      reason: "malformed",
    });
  }
  return {
    network,
    compressed: true,
    privateKey: decoded.payload.slice(0, 32),
  };
}

// The private key of a WIF a wallet of `network` can use: one of the network's key version.
// Regtest takes WIFs of either version byte, as it always did.
export function wifPrivateKey(wif: string, network: Network): Uint8Array {
  const decoded = decodeWif(wif);

  if (
    network !== NetworkType.Regtest &&
    (decoded.network as string) !== networkConfig(network).keyVersion
  ) {
    throw new InvalidWifError(
      `WIF is for ${decoded.network}, expected ${network}`,
      { reason: "network", network: decoded.network },
    );
  }

  // an uncompressed key's funds are on the address of its uncompressed public key,
  // which this wallet does not derive or sign for
  if (!decoded.compressed) {
    throw new InvalidWifError(
      "Uncompressed WIF private keys are not supported",
      { reason: "uncompressed", network: decoded.network },
    );
  }

  return decoded.privateKey;
}
