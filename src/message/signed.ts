import {
  base64ToBin,
  bigIntToCompactUint,
  binsAreEqual,
  binToBase64,
  CashAddressType,
  decodeCashAddress,
  decodeCashAddressFormatWithoutPrefix,
  isBase64,
  RecoveryId,
  secp256k1,
  sha256,
  utf8ToBin,
} from "@bitauth/libauth";

import { hash160 } from "../util/hash160.js";
import { SignedMessageResponseI, VerifyMessageResponseI } from "./interface.js";

/**
 * message_magic - Add "Magic", per standard bitcoin message signing.
 *
 * In this case, the magic is simply adding the number 24 as binary "\x18", and "Bitcoin Signed Message\n" followed
 * by the size of the message in Bitcoin's "varint" format followed by the message encoded as binary.
 *
 * @param {str} string    The string to add the magic syntax to.
 *
 * @returns a promise to the string as binary array with magic syntax
 */
// see    https://github.com/Electron-Cash/Electron-Cash/blob/49f9f672364f50053a026e4a5cb30e92db2d195d/electroncash/bitcoin.py#L524
function message_magic(str: string) {
  const msgBytes = utf8ToBin(str);
  const payload = `\x18Bitcoin Signed Message:\n`;
  return new Uint8Array([
    ...utf8ToBin(payload),
    ...bigIntToCompactUint(BigInt(msgBytes.length)),
    ...msgBytes,
  ]);
}

/**
 * hash_magic - Return the hash of the string that has undergone standard formatting
 *
 * @param {str} string    The string to hash
 *
 * @returns a promise to the hash of the string.
 */
export function hash_message(str: string) {
  const h = sha256.hash;
  return h(h(message_magic(str)));
}

// The payload of a P2PKH cashaddr in either case, with or without its prefix (a given prefix is
// checked by the checksum), or undefined for anything else
function p2pkhPayload(cashaddr: string): Uint8Array | undefined {
  let address = cashaddr;
  if (!address.includes(":")) {
    const format = decodeCashAddressFormatWithoutPrefix(address);
    if (typeof format === "string") return undefined;
    address = `${format.prefix}:${address}`;
  }
  const decoded = decodeCashAddress(address);
  if (typeof decoded === "string") return undefined;
  if (
    decoded.type !== CashAddressType.p2pkh &&
    decoded.type !== CashAddressType.p2pkhWithTokens
  ) {
    return undefined;
  }
  return decoded.payload;
}

export class SignedMessage {
  /**
   * sign - Calculate the recoverable signature of a string message, in the encoding Electron Cash
   * uses (a compressed key's recovery id plus 31, then the 64-byte compact signature, as base64).
   *
   * @param {message} string          The message to sign as a utf8 string
   * @param {privateKey} Uint8Array   The private key to sign the message with
   *
   * @returns the signature
   */
  public static sign(
    message: string,
    privateKey: Uint8Array,
  ): SignedMessageResponseI {
    const messageHash = hash_message(message);
    const rs = secp256k1.signMessageHashRecoverableCompact(
      privateKey,
      messageHash,
    );
    if (typeof rs === "string") {
      throw new Error(rs);
    }
    const electronEncoding = new Uint8Array([
      31 + rs.recoveryId,
      ...rs.signature,
    ]);
    return { signature: binToBase64(electronEncoding) };
  }

  /**
   * verify - Validate a recoverable signature of a message against the P2PKH address that signed it
   *
   * @param {message} string     The message to verify as a utf8 string
   * @param {signature} string   The recoverable signature as a base64 encoded string
   * @param {cashaddr} string    The cashaddr or tokenaddr the recovered public key must hash to
   *
   * @returns whether the signature is valid for the message and the address
   */
  public static verify(
    message: string,
    signature: string,
    cashaddr: string,
  ): VerifyMessageResponseI {
    const messageHash = hash_message(message);
    // base64ToBin decodes invalid input to garbage; read it as no signature
    const sig = isBase64(signature) ? base64ToBin(signature) : new Uint8Array();
    if (sig.length !== 65) {
      return { valid: false };
    }

    // 31..34: a compressed key's recovery id 0..3, as Electron Cash encodes it
    const recoveryId = sig[0] - 31;
    if (recoveryId < 0 || recoveryId > 3) {
      return { valid: false };
    }
    const rawSig = sig.slice(1);
    const recoveredPk = secp256k1.recoverPublicKeyCompressed(
      rawSig,
      recoveryId as RecoveryId,
      messageHash,
    );
    if (typeof recoveredPk === "string") {
      return { valid: false };
    }

    const signatureValid = secp256k1.verifySignatureCompact(
      rawSig,
      recoveredPk,
      messageHash,
    );
    const payload = p2pkhPayload(cashaddr);
    const pkhMatch =
      payload !== undefined && binsAreEqual(payload, hash160(recoveredPk));
    return { valid: signatureValid && pkhMatch };
  }
}
