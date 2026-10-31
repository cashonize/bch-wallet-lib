import {
  AnyCompilerConfiguration,
  AuthenticationProgramStateCommon,
  bigIntToCompactUint,
  CompilationContextBch,
  Compiler,
  cashAddressToLockingBytecode,
  encodeTransaction,
  encodeTransactionOutputs,
  generateTransaction,
  hexToBin,
  importWalletTemplate,
  Output,
  verifyTransactionTokens,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBch,
} from "@bitauth/libauth";
import { WalletCache } from "../cache/walletCache.js";
import { DUST_UTXO_THRESHOLD, MAX_OP_RETURN_BYTES } from "../constant.js";
import { NFTCapability, Utxo } from "../interface.js";
import { sumSendRequestAmounts } from "../util/sumSendRequestAmounts.js";
import { tokenOutput } from "../util/tokenOutput.js";
import { sumUtxoValue } from "../util/sumUtxoValue.js";
import { InsufficientFundsError } from "../wallet/errors.js";
import {
  OpReturnData,
  SendRequest,
  SendRequestType,
  TokenSendRequest,
} from "../wallet/model.js";
import {
  checkTokenConservation,
  TokenBurnAllowance,
} from "./tokenConservation.js";

export const placeholderPrivateKey =
  "0000000000000000000000000000000000000000000000000000000000000001";
export const placeholderPrivateKeyBin = hexToBin(placeholderPrivateKey);

// Build a transaction for a p2pkh transaction for a non HD wallet
export async function buildP2pkhNonHdTransaction({
  inputs,
  outputs,
  signingKey,
  fee = 0n,
  discardChange = false,
  changeAddress = "",
  walletCache,
  tokenBurns,
  tokenChange = [],
}: {
  inputs: Utxo[];
  outputs: Array<SendRequest | TokenSendRequest | OpReturnData>;
  signingKey?: Uint8Array;
  fee?: bigint;
  discardChange?: boolean;
  changeAddress?: string;
  walletCache: WalletCache;
  /** when given, refuse outputs that destroy more of the inputs' tokens than this allows */
  tokenBurns?: TokenBurnAllowance;
  /** the token change, placed after the outputs */
  tokenChange?: TokenSendRequest[];
}) {
  if (!signingKey) {
    throw new Error("Missing signing key when building transaction");
  }

  const template = importWalletTemplate(walletTemplateP2pkhNonHd);
  if (typeof template === "string") {
    throw new Error("Transaction template error");
  }

  const compiler = walletTemplateToCompilerBch(template);
  const inputAmount = sumUtxoValue(inputs);

  outputs = [...outputs, ...tokenChange];
  // a transaction of nothing but BCH change sends nothing
  if (outputs.length === 0) {
    throw Error("A send needs at least one output");
  }
  const paidOutAmount = await sumSendRequestAmounts(outputs);
  // the fee comes out of the change
  const changeAmount =
    BigInt(inputAmount) - BigInt(paidOutAmount) - BigInt(fee);
  if (changeAmount < 0n) {
    throw amountNotMetError(paidOutAmount + fee, inputAmount);
  }

  // the change goes last, unless discardChange is set or it would be dust
  if (discardChange !== true && changeAmount > DUST_UTXO_THRESHOLD) {
    if (!changeAddress) {
      changeAddress = inputs[0].address;
    }
    outputs = [
      ...outputs,
      new SendRequest({ cashaddr: changeAddress, value: BigInt(changeAmount) }),
    ];
  }

  const lockedOutputs = await prepareOutputs(outputs);
  if (tokenBurns) {
    checkTokenConservation(inputs, lockedOutputs, tokenBurns);
  }

  const { preparedInputs, sourceOutputs } = prepareInputs({
    inputs,
    compiler,
    signingKey,
    walletCache,
  });
  const result = generateTransaction({
    inputs: preparedInputs,
    locktime: 0,
    outputs: lockedOutputs,
    version: 2,
  });

  if (!result.success) {
    throw Error("Error building transaction with fee");
  }

  const tokenValidationResult = verifyTransactionTokens(
    result.transaction,
    sourceOutputs,
    { maximumTokenCommitmentLength: 128 },
  );
  if (tokenValidationResult !== true && fee > 0) {
    throw new Error(tokenValidationResult);
  }

  return { transaction: result.transaction };
}

export function prepareInputs({
  inputs,
  compiler,
  signingKey,
  walletCache,
}: {
  inputs: Utxo[];
  compiler: Compiler<
    CompilationContextBch,
    AnyCompilerConfiguration<CompilationContextBch>,
    AuthenticationProgramStateCommon
  >;
  signingKey: Uint8Array;
  walletCache: WalletCache;
}) {
  const preparedInputs: any[] = [];
  const sourceOutputs: any[] = [];
  for (const i of inputs) {
    const utxoTxnValue = i.satoshis;
    const utxoIndex = i.vout;
    // slice will create a clone of the array
    const utxoOutpointTransactionHash = new Uint8Array(
      i.txid.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );
    // reverse the cloned copy
    // utxoOutpointTransactionHash.reverse();
    if (!utxoOutpointTransactionHash || utxoIndex === undefined) {
      throw new Error("Missing unspent outpoint when building transaction");
    }

    const libAuthToken = i.token && {
      amount: BigInt(i.token.amount),
      category: hexToBin(i.token.category),
      nft:
        i.token.nft?.capability !== undefined ||
        i.token.nft?.commitment !== undefined
          ? {
              capability: i.token.nft?.capability,
              commitment: hexToBin(i.token.nft?.commitment ?? ""),
            }
          : undefined,
    };
    const key =
      walletCache.get(i.address)?.privateKey ??
      (signingKey?.length ? signingKey : Uint8Array.from(Array(32)));
    const newInput = {
      outpointIndex: utxoIndex,
      outpointTransactionHash: utxoOutpointTransactionHash,
      sequenceNumber: 0,
      unlockingBytecode: {
        compiler,
        data: {
          keys: { privateKeys: { key: key } },
        },
        valueSatoshis: BigInt(utxoTxnValue),
        script: "unlock",
        token: libAuthToken,
      },
    };

    preparedInputs.push(newInput);

    const lockingBytecode = cashAddressToLockingBytecode(i.address);
    if (typeof lockingBytecode === "string") {
      throw new Error(lockingBytecode);
    }

    sourceOutputs.push({
      outpointIndex: utxoIndex,
      outpointTransactionHash: utxoOutpointTransactionHash,
      sequenceNumber: 0,
      unlockingBytecode: Uint8Array.from([]),

      // additional info for sourceOutputs
      lockingBytecode: lockingBytecode.bytecode,
      valueSatoshis: BigInt(utxoTxnValue),
      token: libAuthToken,
    });
  }
  return { preparedInputs, sourceOutputs };
}

/**
 * prepareOutputs - create outputs for a transaction from a list of send requests
 *
 * a wrapper function
 *
 * @returns A promise to a list of unspent outputs
 */
export async function prepareOutputs(
  outputs: Array<SendRequest | TokenSendRequest | OpReturnData>,
) {
  const opReturnBytes = outputs
    .filter((output) => output instanceof OpReturnData)
    .reduce((sum, output) => sum + output.buffer.length, 0);
  if (opReturnBytes > MAX_OP_RETURN_BYTES) {
    throw new Error(
      `OP_RETURN outputs can not exceed ${MAX_OP_RETURN_BYTES} bytes in total, got ${opReturnBytes}`,
    );
  }

  const lockedOutputs: Output[] = [];
  for (const output of outputs) {
    if (output instanceof TokenSendRequest) {
      lockedOutputs.push(tokenOutput(output));
      continue;
    }

    if (output instanceof OpReturnData) {
      lockedOutputs.push(prepareOpReturnOutput(output));
      continue;
    }

    const outputLockingBytecode = cashAddressToLockingBytecode(output.cashaddr);
    if (typeof outputLockingBytecode === "string")
      throw new Error(outputLockingBytecode);

    const sendAmount = Number(output.value);
    if (sendAmount % 1 !== 0) {
      throw Error(
        `Cannot send ${sendAmount} satoshis, (fractional sats do not exist, yet), please use an integer number.`,
      );
    }
    const lockedOutput: Output = {
      lockingBytecode: outputLockingBytecode.bytecode,
      valueSatoshis: BigInt(sendAmount),
    };
    lockedOutputs.push(lockedOutput);
  }
  return lockedOutputs;
}

/**
 * prepareOpReturnOutput - create an output for OP_RETURN data
 *
 * @returns A promise to a list of unspent outputs
 */
export function prepareOpReturnOutput(request: OpReturnData): Output {
  return {
    lockingBytecode: request.buffer,
    valueSatoshis: BigInt(0),
  };
}

/**
 * getSuitableUtxos - Filter a list of unspent transaction outputs to the minimum needed to complete a transaction
 *
 * a intermediate function
 *
 * @param unspentOutputs  An unfiltered list of available unspent transaction outputs
 *
 * @returns A promise to a list of unspent outputs
 */
export async function getSuitableUtxos(
  inputs: Utxo[],
  amountRequired: bigint | undefined,
  requests: SendRequestType[],
  ensureUtxos: Utxo[] = [],
  tokenOperation: "send" | "genesis" | "mint" | "burn" = "send",
): Promise<Utxo[]> {
  const utxoKey = (u: Utxo) => `${u.txid}:${u.vout}`;
  const selectedSet = new Set<string>();
  const suitableUtxos: Utxo[] = [];

  for (const u of ensureUtxos) {
    const key = utxoKey(u);
    if (!selectedSet.has(key)) {
      selectedSet.add(key);
      suitableUtxos.push(u);
    }
  }

  let amountAvailable = suitableUtxos.reduce(
    (sum, u) => sum + BigInt(u.satoshis),
    BigInt(0),
  );
  const allTokenRequests = requests.filter(
    (val) => val instanceof TokenSendRequest,
  ) as TokenSendRequest[];
  // mutable requests go last, so that a minting coin any other request spends is selected by the
  // time a new mutable NFT looks for one to back it, whatever order the caller gave
  const isMutableRequest = (request: TokenSendRequest) =>
    request.nft?.capability === NFTCapability.mutable;
  const tokenRequests = [
    ...allTokenRequests.filter((request) => !isMutableRequest(request)),
    ...allTokenRequests.filter(isMutableRequest),
  ];

  const usedIndices = new Set<number>();

  // Track how many times each selected UTXO has been "claimed" by a request
  const claimedUtxos = new Map<string, number>();

  // find matching utxos for token transfers
  if (tokenOperation === "send") {
    for (const request of tokenRequests) {
      // Search suitableUtxos then inputs sequentially to find matching tokens
      const matchCommitment = (val: Utxo) =>
        val.token?.category === request.category &&
        val.token?.nft?.capability === request.nft?.capability &&
        val.token?.nft?.commitment === request.nft?.commitment;

      // For NFTs (non-fungible), each request needs its own UTXO
      // For FT-only requests, a single UTXO can satisfy multiple requests
      const isFungibleOnly =
        request.nft?.capability === undefined &&
        request.nft?.commitment === undefined;

      // Check already-selected suitable utxos first (no need to re-add)
      let found = false;
      if (isFungibleOnly) {
        found = suitableUtxos.some(matchCommitment);
      } else {
        // For NFTs, find an unclaimed matching UTXO in suitableUtxos
        for (const val of suitableUtxos) {
          if (!matchCommitment(val)) continue;
          const key = utxoKey(val);
          const claims = claimedUtxos.get(key) || 0;
          if (claims === 0) {
            claimedUtxos.set(key, claims + 1);
            found = true;
            break;
          }
        }
      }

      if (!found) {
        // Search available inputs for same commitment match
        for (let i = 0; i < inputs.length; i++) {
          if (usedIndices.has(i)) continue;
          const val = inputs[i];
          if (val.token?.category !== request.category) continue;
          if (!matchCommitment(val)) continue;
          const key = utxoKey(val);
          if (selectedSet.has(key)) continue;

          selectedSet.add(key);
          suitableUtxos.push(val);
          usedIndices.add(i);
          amountAvailable += BigInt(val.satoshis);
          if (!isFungibleOnly) {
            claimedUtxos.set(key, 1);
          }
          found = true;
          break;
        }
      }

      if (found) continue;

      if (
        request.nft?.capability === NFTCapability.minting ||
        request.nft?.capability === NFTCapability.mutable
      ) {
        // Under consensus a minting input backs any number of NFT outputs of its category, so a
        // selected minting coin covers the request; a mutable input backs one, so a mutable
        // request claims its coin as an NFT request claims its exact match
        const isMutable = request.nft?.capability === NFTCapability.mutable;
        const matchCapability = (val: Utxo) =>
          val.token?.category === request.category &&
          val.token?.nft?.capability === request.nft?.capability;

        // Check already-selected suitable utxos first
        const hasMinting = suitableUtxos.some(
          (val) =>
            val.token?.category === request.category &&
            val.token?.nft?.capability === NFTCapability.minting,
        );
        if (hasMinting) continue;

        let foundCapability = false;
        if (isMutable) {
          for (const val of suitableUtxos) {
            if (!matchCapability(val)) continue;
            const key = utxoKey(val);
            if (claimedUtxos.has(key)) continue;
            claimedUtxos.set(key, 1);
            foundCapability = true;
            break;
          }
        }
        if (foundCapability) continue;

        for (let i = 0; i < inputs.length; i++) {
          if (usedIndices.has(i)) continue;
          const val = inputs[i];
          if (!matchCapability(val)) continue;
          const key = utxoKey(val);
          if (selectedSet.has(key)) continue;

          selectedSet.add(key);
          suitableUtxos.push(val);
          usedIndices.add(i);
          amountAvailable += BigInt(val.satoshis);
          if (isMutable) {
            claimedUtxos.set(key, 1);
          }
          foundCapability = true;
          break;
        }
        if (foundCapability) continue;

        // with no mutable NFT left to claim, a minting coin of the category backs the new mutable
        // NFT, and comes back as change as a minting coin spent for another request does
        if (isMutable) {
          for (let i = 0; i < inputs.length; i++) {
            if (usedIndices.has(i)) continue;
            const val = inputs[i];
            if (
              val.token?.category !== request.category ||
              val.token?.nft?.capability !== NFTCapability.minting
            ) {
              continue;
            }
            const key = utxoKey(val);
            if (selectedSet.has(key)) continue;

            selectedSet.add(key);
            suitableUtxos.push(val);
            usedIndices.add(i);
            amountAvailable += BigInt(val.satoshis);
            foundCapability = true;
            break;
          }
          if (foundCapability) continue;
        }
      }

      // handle splitting the hybrid (FT+NFT) token into its parts
      if (
        request.nft?.capability === undefined &&
        request.nft?.commitment === undefined
      ) {
        const hasCategoryInSuitable = suitableUtxos.some(
          (val) => val.token?.category === request.category,
        );
        const hasCategoryInInputs =
          !hasCategoryInSuitable &&
          inputs.some(
            (val, i) =>
              !usedIndices.has(i) && val.token?.category === request.category,
          );
        if (hasCategoryInSuitable || hasCategoryInInputs) {
          continue;
        }
      }

      throw new InsufficientFundsError(
        `No suitable token utxos available to send token with id "${request.category}", capability "${request.nft?.capability}", commitment "${request.nft?.commitment}"`,
        { asset: "token", category: request.category },
      );
    }
  }

  // top up with plain BCH coins in the pool's order
  const alreadyEnough =
    amountRequired !== undefined && amountAvailable >= amountRequired;
  if (!alreadyEnough) {
    for (let i = 0; i < inputs.length; i++) {
      if (amountRequired && amountAvailable >= amountRequired) break;
      if (usedIndices.has(i)) continue;
      const u = inputs[i];
      if (u.token) continue;
      const key = utxoKey(u);
      if (selectedSet.has(key)) continue;
      selectedSet.add(key);
      suitableUtxos.push(u);
      amountAvailable += BigInt(u.satoshis);
    }
  }

  // If the amount needed is met, or no amount is given, return
  if (typeof amountRequired === "undefined") {
    return suitableUtxos;
  } else if (amountAvailable < amountRequired) {
    throw amountNotMetError(amountRequired, amountAvailable);
  } else {
    return suitableUtxos;
  }
}

export function amountNotMetError(required: bigint, available: bigint) {
  const e = new InsufficientFundsError(
    `Amount required was not met, ${required} satoshis needed, ${available} satoshis available`,
    { asset: "bch" },
  );
  e["data"] = { required, available };
  return e;
}

/**
 * selectFungibleTokenUtxos - the token coins a send adds to cover the fungible amounts it sends
 * (mainnet-js#246)
 *
 * Per category, the fungible tokens on the coins the send spends anyway count first; the rest is
 * covered by fungible-only coins, largest first, then by NFT coins holding fungible tokens, largest
 * first, so that an NFT moves only when the fungible-only coins fall short.
 *
 * @param inputs  The utxos the send may spend
 * @param pinned  The utxos the send spends anyway: ensureUtxos and the inputs of its NFT requests
 * @param requests  The requested token outputs
 */
export function selectFungibleTokenUtxos(
  inputs: Utxo[],
  pinned: Utxo[],
  requests: TokenSendRequest[],
): Utxo[] {
  const utxoKey = (u: Utxo) => `${u.txid}:${u.vout}`;
  const pinnedKeys = new Set(pinned.map(utxoKey));
  const selected: Utxo[] = [];

  const categories = requests
    .map((val) => val.category)
    .filter((val, idx, arr) => arr.indexOf(val) === idx);
  for (const category of categories) {
    const requested = requests
      .filter((val) => val.category === category)
      .reduce((sum, val) => sum + val.amount, 0n);
    let available = pinned
      .filter((val) => val.token?.category === category)
      .reduce((sum, val) => sum + val.token!.amount, 0n);

    const candidates = inputs
      .filter(
        (val) =>
          val.token?.category === category &&
          val.token.amount > 0n &&
          !pinnedKeys.has(utxoKey(val)),
      )
      .sort((a, b) => {
        const aHasNft = !!a.token!.nft;
        const bHasNft = !!b.token!.nft;
        if (aHasNft !== bHasNft) {
          return aHasNft ? 1 : -1;
        }
        if (a.token!.amount === b.token!.amount) {
          return 0;
        }
        return a.token!.amount > b.token!.amount ? -1 : 1;
      });
    for (const candidate of candidates) {
      if (available >= requested) break;
      selected.push(candidate);
      available += candidate.token!.amount;
    }

    if (available < requested) {
      throw new InsufficientFundsError("Not enough token amount to send", {
        asset: "token",
        category,
      });
    }
  }
  return selected;
}

/**
 * getTokenChangeRequests - the token change of a send: what the spent token inputs carry minus
 * what the requests send, per category and per NFT (mainnet-js#247)
 *
 * An NFT input no request sends comes back as it was, with its own fungible amount as far as the
 * category's fungible change covers it; the rest of that change goes to one fungible-only output.
 *
 * @param inputs  The token inputs the transaction spends
 * @param requests  The requested token outputs
 * @param changeAddress  Gives each change output the token-aware address it goes to
 */
export function getTokenChangeRequests(
  inputs: Utxo[],
  requests: TokenSendRequest[],
  changeAddress: () => string,
): TokenSendRequest[] {
  const tokenInputs = inputs.filter((input) => input.token);
  const sent = new Set<Utxo>();

  // an NFT request sends the input with the same NFT, matched as getSuitableUtxos claims them
  const unmatched: TokenSendRequest[] = [];
  for (const request of requests) {
    if (
      request.nft?.capability === undefined &&
      request.nft?.commitment === undefined
    ) {
      continue;
    }
    const input = tokenInputs.find(
      (val) =>
        !sent.has(val) &&
        val.token!.category === request.category &&
        val.token!.nft?.capability === request.nft?.capability &&
        val.token!.nft?.commitment === request.nft?.commitment,
    );
    if (input) {
      sent.add(input);
    } else {
      unmatched.push(request);
    }
  }
  // a minting or mutable NFT sent with another commitment is a minting or mutable input changed,
  // except a mutable NFT of a category whose minting input is spent: that input backs it, and the
  // mutable inputs come back as they were
  const mintingSpent = (category: string) =>
    tokenInputs.some(
      (val) =>
        val.token!.category === category &&
        val.token!.nft?.capability === NFTCapability.minting,
    );
  for (const request of unmatched) {
    if (
      request.nft?.capability !== NFTCapability.minting &&
      request.nft?.capability !== NFTCapability.mutable
    ) {
      continue;
    }
    if (
      request.nft.capability === NFTCapability.mutable &&
      mintingSpent(request.category)
    ) {
      continue;
    }
    const input = tokenInputs.find(
      (val) =>
        !sent.has(val) &&
        val.token!.category === request.category &&
        val.token!.nft?.capability === request.nft?.capability,
    );
    if (input) {
      sent.add(input);
    }
  }

  const changeRequests: TokenSendRequest[] = [];
  const categories = tokenInputs
    .map((val) => val.token!.category)
    .filter((val, idx, arr) => arr.indexOf(val) === idx);
  for (const category of categories) {
    const categoryInputs = tokenInputs.filter(
      (val) => val.token!.category === category,
    );
    const categoryRequests = requests.filter(
      (val) => val.category === category,
    );
    let change =
      categoryInputs.reduce((sum, val) => sum + val.token!.amount, 0n) -
      categoryRequests.reduce((sum, val) => sum + val.amount, 0n);
    if (change < 0n) {
      throw new InsufficientFundsError("Not enough token amount to send", {
        asset: "token",
        category,
      });
    }

    for (const input of categoryInputs) {
      const nft = input.token!.nft;
      if (!nft || sent.has(input)) continue;
      let amount = input.token!.amount;
      if (amount > change) {
        amount = change;
      }
      change -= amount;
      changeRequests.push(
        new TokenSendRequest({
          cashaddr: changeAddress(),
          category,
          amount,
          nft: { capability: nft.capability, commitment: nft.commitment },
          // the input's own value, which is above dust for the token data it carried
          value: input.satoshis,
        }),
      );
    }
    if (change > 0n) {
      // no value: the standard 1000 sats of a token output, above dust for any fungible-only
      // output; a request's value is what its recipient gets, not what the change needs
      changeRequests.push(
        new TokenSendRequest({
          cashaddr: changeAddress(),
          category,
          amount: change,
        }),
      );
    }
  }
  return changeRequests;
}

// model-based imprecise and fast fee estimation
export async function getFeeAmountSimple({
  utxos,
  sendRequests,
  relayFeePerByteInSatoshi,
  discardChange,
}: {
  utxos: Utxo[];
  sendRequests: Array<SendRequest | TokenSendRequest | OpReturnData>;
  sourceAddress: string;
  relayFeePerByteInSatoshi: number;
  discardChange?: boolean;
}): Promise<bigint> {
  const inputSizeP2pkh = 148;
  const outputSizeP2pkh = 34;

  const inputTotalSize = utxos.reduce(
    (prev, curr) =>
      prev +
      (curr.token
        ? inputSizeP2pkh +
          1 +
          34 +
          Math.round(1 + (curr.token.nft?.commitment?.length ?? 0) / 2) +
          (curr.token.amount ? 9 : 0)
        : inputSizeP2pkh),
    0,
  );

  const outputSize = (sendRequest: SendRequestType) => {
    if (sendRequest.hasOwnProperty("category")) {
      const tokenRequest = sendRequest as TokenSendRequest;
      return (
        outputSizeP2pkh +
        1 +
        34 +
        Math.round(1 + (tokenRequest.nft?.commitment?.length ?? 0) / 2) +
        (tokenRequest.amount ? 9 : 0)
      );
    } else if (sendRequest.hasOwnProperty("buffer")) {
      return 9 + (sendRequest as OpReturnData).buffer.length;
    } else {
      return outputSizeP2pkh;
    }
  };

  const outputTotalSize =
    sendRequests.reduce((prev, curr) => prev + outputSize(curr), 0) +
    (discardChange ? 0 : outputSizeP2pkh);
  const txSizeBytes = inputTotalSize + outputTotalSize + 16;

  return BigInt(Math.ceil(txSizeBytes * relayFeePerByteInSatoshi));
}

// A P2PKH input as this library signs it: outpoint, script length, a 65-byte Schnorr signature
// and a 33-byte compressed key with their pushes, sequence
const P2PKH_SCHNORR_INPUT_SIZE = 36 + 1 + 100 + 4;

/**
 * The fee of a transaction spending these coins to these outputs, with no change: exact for the
 * library's own P2PKH inputs, which getFeeAmountSimple overcounts, and rounded as getFeeAmount
 * rounds, so that the precise fee of the built transaction is not above it.
 */
export async function getFeeAmountWithoutChange({
  utxos,
  sendRequests,
  relayFeePerByteInSatoshi,
}: {
  utxos: Utxo[];
  sendRequests: Array<SendRequest | TokenSendRequest | OpReturnData>;
  relayFeePerByteInSatoshi: number;
}): Promise<bigint> {
  const outputs = encodeTransactionOutputs(await prepareOutputs(sendRequests));
  const txSizeBytes =
    4 + // version
    bigIntToCompactUint(BigInt(utxos.length)).length +
    utxos.length * P2PKH_SCHNORR_INPUT_SIZE +
    outputs.length +
    4; // locktime
  return BigInt(Math.ceil(txSizeBytes * relayFeePerByteInSatoshi + 1));
}

// precise fee estimation
export async function getFeeAmount({
  utxos,
  sendRequests,
  relayFeePerByteInSatoshi,
  discardChange,
  walletCache,
  tokenChange,
}: {
  utxos: Utxo[];
  sendRequests: Array<SendRequest | TokenSendRequest | OpReturnData>;
  sourceAddress: string;
  relayFeePerByteInSatoshi: number;
  discardChange?: boolean;
  walletCache: WalletCache;
  tokenChange?: TokenSendRequest[];
}) {
  // build transaction
  if (utxos) {
    // Build the transaction to get the approximate size
    const draftTransaction = await buildEncodedTransaction({
      inputs: utxos,
      outputs: sendRequests,
      signingKey: placeholderPrivateKeyBin,
      fee: 0n, //DUST_UTXO_THRESHOLD
      discardChange: discardChange ?? false,
      changeAddress: "",
      walletCache,
      tokenChange,
    });
    return BigInt(
      Math.ceil(draftTransaction.length * relayFeePerByteInSatoshi + 1),
    );
  } else {
    throw new InsufficientFundsError(
      "The available inputs in the wallet cannot satisfy this send request",
      { asset: "bch" },
    );
  }
}

// Build encoded transaction
export async function buildEncodedTransaction({
  inputs,
  outputs,
  signingKey,
  fee = 0n,
  discardChange = false,
  changeAddress = "",
  walletCache,
  tokenBurns,
  tokenChange,
}: {
  inputs: Utxo[];
  outputs: Array<SendRequest | TokenSendRequest | OpReturnData>;
  signingKey: Uint8Array;
  fee?: bigint;
  discardChange?: boolean;
  changeAddress?: string;
  walletCache: WalletCache;
  tokenBurns?: TokenBurnAllowance;
  tokenChange?: TokenSendRequest[];
}) {
  const { transaction } = await buildP2pkhNonHdTransaction({
    inputs,
    outputs,
    signingKey,
    fee,
    discardChange,
    changeAddress,
    walletCache,
    tokenBurns,
    tokenChange,
  });

  return encodeTransaction(transaction);
}
