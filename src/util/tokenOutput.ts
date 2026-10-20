import {
  cashAddressToLockingBytecode,
  getDustThreshold,
  hexToBin,
  Output,
} from "@bitauth/libauth";
import { TokenI } from "../interface.js";
import { TokenSendRequest } from "../wallet/model.js";

// what a token output holds when its request names no value, unless its dust limit is higher
const DEFAULT_TOKEN_OUTPUT_VALUE = 1000n;

/**
 * tokenOutput - the output a token send request becomes
 *
 * Without a value it holds 1000 sats, or its dust limit where that is higher: the limit grows with
 * the token data, and an NFT whose commitment is longer than about 110 bytes needs more than 1000.
 *
 * @returns A libauth Output
 */
export function tokenOutput(request: TokenSendRequest): Output {
  const token: TokenI = request;
  const outputLockingBytecode = cashAddressToLockingBytecode(request.cashaddr);
  if (typeof outputLockingBytecode === "string")
    throw new Error(outputLockingBytecode);

  const libAuthToken = {
    amount: BigInt(token.amount),
    category: hexToBin(token.category),
    nft:
      token.nft?.capability !== undefined || token.nft?.commitment !== undefined
        ? {
            capability: token.nft?.capability,
            commitment: hexToBin(token.nft?.commitment ?? ""),
          }
        : undefined,
  };

  const output = {
    lockingBytecode: outputLockingBytecode.bytecode,
    valueSatoshis: BigInt(request.value || 0n),
    token: libAuthToken,
  } as Output;
  if (!request.value) {
    const dustLimit = getDustThreshold(output);
    output.valueSatoshis =
      dustLimit > DEFAULT_TOKEN_OUTPUT_VALUE
        ? dustLimit
        : DEFAULT_TOKEN_OUTPUT_VALUE;
  }
  return output;
}
