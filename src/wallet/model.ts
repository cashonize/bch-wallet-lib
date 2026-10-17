import {
  authenticationInstructionsAreMalformed,
  binToUtf8,
  decodeAuthenticationInstructions,
  hexToBin,
  utf8ToBin,
} from "@bitauth/libauth";
import { Config } from "../config.js";
import { DELIMITER, MAX_OP_RETURN_BYTES } from "../constant.js";
import { NFTCapability, UtxoId } from "../interface.js";
import { checkTokenaddr } from "../util/deriveCashaddr.js";
import { InvalidRequestError } from "./errors.js";

// These are the minimal models used to provide types for the express server
//
// This file will be deprecated auto-generated file in the future
// Any business logic contained here should be moved elsewhere in src/

// CashTokens limits: fungible amounts are 64-bit signed, commitments up to 128 bytes (May 2026)
const MAX_FUNGIBLE_AMOUNT = 2n ** 63n - 1n;
const MAX_COMMITMENT_BYTES = 128;

const shown = (value: unknown) =>
  typeof value === "string" ||
  typeof value === "bigint" ||
  typeof value === "number"
    ? String(value)
    : typeof value;

type RequestNft = { capability?: NFTCapability; commitment?: string };

export function checkTokenCategory(category: unknown): void {
  if (typeof category !== "string" || !/^[0-9a-fA-F]{64}$/.test(category)) {
    throw new InvalidRequestError(
      `Invalid category supplied: ${shown(category)}, expected 64 hex characters`,
      { field: "category", value: category },
    );
  }
}

// libauth's hexToBin reads an odd-length or non-hex string as other bytes ("abc" as ab0c)
export function checkTokenCommitment(nft: RequestNft | undefined): void {
  const commitment = nft?.commitment;
  if (commitment === undefined) return;
  if (
    typeof commitment !== "string" ||
    !/^([0-9a-fA-F]{2})*$/.test(commitment)
  ) {
    throw new InvalidRequestError(
      `Invalid NFT commitment: ${shown(commitment)}, expected an even number of hex characters`,
      { field: "nft.commitment", value: commitment },
    );
  }
  if (commitment.length / 2 > MAX_COMMITMENT_BYTES) {
    throw new InvalidRequestError(
      `NFT commitment of ${commitment.length / 2} bytes exceeds ${MAX_COMMITMENT_BYTES} bytes`,
      { field: "nft.commitment", value: commitment },
    );
  }
}

/** The fungible amount as a bigint, 0n when not given; throws when it is out of range. */
export function toTokenAmount(amount: unknown): bigint {
  if (amount === undefined || amount === null) return 0n;
  let result: bigint | undefined;
  if (typeof amount === "bigint") {
    result = amount;
  } else if (typeof amount === "number" && Number.isInteger(amount)) {
    result = BigInt(amount);
  } else if (typeof amount === "string" && /^-?[0-9]+$/.test(amount)) {
    result = BigInt(amount);
  }
  if (result === undefined || result < 0n || result > MAX_FUNGIBLE_AMOUNT) {
    throw new InvalidRequestError(
      `Invalid fungible token amount: ${shown(amount)}, expected an integer from 0 to ${MAX_FUNGIBLE_AMOUNT}`,
      { field: "amount", value: amount },
    );
  }
  return result;
}

const hasNft = (nft: RequestNft | undefined) =>
  nft?.capability !== undefined || nft?.commitment !== undefined;

// a token prefix with no NFT and a zero amount is invalid on chain
export function checkTokenOutput(
  amount: bigint,
  nft: RequestNft | undefined,
): void {
  if (amount === 0n && !hasNft(nft)) {
    throw new InvalidRequestError(
      "A token output needs a positive fungible amount or an NFT",
      { field: "nft", value: nft },
    );
  }
}

/** Validates a genesis request's token data, before the operation reads any coin. */
export function checkGenesisRequest(request: TokenGenesisRequest): void {
  const amount = toTokenAmount(request.amount);
  checkTokenCommitment(request.nft);
  checkTokenOutput(amount, request.nft);
}

/** Validates a mint request's token data, before the operation reads any coin. */
export function checkMintRequest(request: TokenMintRequest): void {
  checkTokenCategory(request.category);
  checkTokenCommitment(request.nft);
  checkTokenOutput(0n, request.nft);
}

/** Validates a burn request's token data, before the operation reads any coin. */
export function checkBurnRequest(request: TokenBurnRequest): void {
  checkTokenCategory(request.category);
  checkTokenCommitment(request.nft);
  toTokenAmount(request.amount);
}

export type SendRequestType =
  | SendRequest
  | TokenSendRequest
  | OpReturnData
  | Array<SendRequest | TokenSendRequest | OpReturnData>;

export class SendRequest {
  cashaddr: string;
  value: bigint;

  constructor({ cashaddr, value }: { cashaddr: string; value: bigint }) {
    this.cashaddr = cashaddr;
    this.value = BigInt(value);
  }
}

export class TokenGenesisRequest {
  amount?: bigint; // fungible token amount
  nft?: {
    capability: NFTCapability;
    commitment: string;
  };
  cashaddr?: string;
  value?: bigint; // satoshi value

  constructor({
    amount,
    nft,
    cashaddr,
    value,
  }: {
    amount?: bigint;
    nft?: {
      capability: NFTCapability;
      commitment: string;
    };
    cashaddr?: string;
    value?: bigint;
  }) {
    this.amount = amount;
    this.nft = nft;
    this.cashaddr = cashaddr;
    this.value = value;
    checkGenesisRequest(this);
  }
}

export class TokenBurnRequest {
  category: string;
  amount?: bigint; // fungible token amount
  nft?: {
    capability: NFTCapability;
    commitment: string;
  };

  constructor({
    category,
    amount,
    nft,
  }: {
    category: string;
    amount?: number | bigint;
    nft?: {
      capability: NFTCapability;
      commitment: string;
    };
  }) {
    this.category = category;
    this.amount = toTokenAmount(amount);
    this.nft = nft;
    checkBurnRequest(this);
  }
}

export class TokenSendRequest {
  cashaddr: string; // cashaddr or tokenaddr to send tokens to
  value?: bigint; // satoshi value
  amount: bigint; // fungible token amount
  category: string;
  nft?: {
    capability: NFTCapability;
    commitment: string;
  };

  constructor({
    cashaddr,
    value,
    amount,
    category,
    nft,
  }: {
    cashaddr: string;
    value?: bigint;
    amount?: bigint;
    category: string;
    nft?: {
      capability: NFTCapability;
      commitment: string;
    };
  }) {
    checkTokenCategory(category);
    checkTokenCommitment(nft);
    this.amount = toTokenAmount(amount);
    checkTokenOutput(this.amount, nft);
    checkTokenaddr(cashaddr, Config.EnforceCashTokenReceiptAddresses);

    this.cashaddr = cashaddr;
    this.value = value;
    this.category = category;
    this.nft = nft;
  }
}

export class TokenMintRequest {
  category: string;
  nft?: {
    capability: NFTCapability;
    commitment: string;
  };
  cashaddr?: string;
  value?: bigint;

  constructor({
    category,
    nft,
    cashaddr,
    value,
  }: {
    category: string;
    nft?: {
      capability: NFTCapability;
      commitment: string;
    };
    cashaddr?: string;
    value?: bigint;
  }) {
    this.category = category;
    this.nft = nft;
    this.cashaddr = cashaddr;
    this.value = value;
    checkMintRequest(this);
  }
}

export class OpReturnData {
  buffer: Uint8Array;

  public constructor(buffer: Uint8Array) {
    this.buffer = Uint8Array.from(buffer);
  }

  /**
   * from - Construct OP_RETURN data from arbitrary data type
   *
   * @param string   UTF-8 encoded string message to be converted to OP_RETURN data
   *
   * @returns class instance
   */
  public static from(data: string | Uint8Array) {
    return this.fromArray([data]);
  }

  /**
   * fromString - Accept data as a simple UTF-8 string message and append an OP_RETURN and PUSH_DATA1 opcodes to it
   *
   * @param string   UTF-8 encoded string message to be converted to OP_RETURN data
   *
   * @returns class instance
   */
  public static fromString(string: string) {
    return this.fromArray([string]);
  }

  /**
   * buffer - Accept OP_RETURN data as a binary buffer.
   * If buffer lacks the OP_RETURN and OP_PUSHDATA opcodes, they will be prepended.
   *
   * @param buffer   Data buffer to be assigned to the OP_RETURN outpit
   *
   * @returns class instance
   */
  public static fromUint8Array(uint8Array: Uint8Array) {
    if (uint8Array[0] !== 0x6a) {
      return this.fromArray([uint8Array]);
    }
    return new this(Uint8Array.from(uint8Array));
  }

  /**
   * fromArray - Accept array of data
   *
   * @param array   Array of Uint8Array or UTF-8 encoded string messages to be converted to OP_RETURN data
   *
   * @returns class instance
   */
  public static fromArray(array: Array<string | Uint8Array>) {
    let data: Uint8Array = Uint8Array.from([0x6a]); // OP_RETURN
    for (const element of array) {
      let length: number;
      let elementData: Uint8Array;
      let lengthData: any;
      if (typeof element === "string") {
        elementData = utf8ToBin(element);
        length = elementData.length;
      } else if (element instanceof Uint8Array) {
        elementData = element;
        length = elementData.length;
      } else {
        throw new Error("Wrong data array element");
      }

      if (length < 76) {
        // direct push, OP_0 for empty data
        lengthData = [length];
      } else if (length < 256) {
        lengthData = [0x4c, length]; // OP_PUSHDATA1
      } else {
        throw new Error(
          `OP_RETURN script can not exceed ${MAX_OP_RETURN_BYTES} bytes in size`,
        );
      }

      data = Uint8Array.from([...data, ...lengthData, ...elementData]);
    }

    if (data.length > MAX_OP_RETURN_BYTES) {
      throw new Error(
        `OP_RETURN script can not exceed ${MAX_OP_RETURN_BYTES} bytes in size`,
      );
    }

    return new this(data);
  }

  /**
   * parseBinary - parse OP_RETURN data and return pushed chunks of binary data
   *
   * An empty push gives an empty chunk, OP_1NEGATE and OP_1..OP_16 their one-byte number.
   * Throws when the script does not start with OP_RETURN, or has a non-push opcode or a truncated push.
   *
   * @param opReturn   Raw OP_RETURN data
   *
   * @returns array of binary data chunks pushed
   */
  public static parseBinary(opReturn: Uint8Array): Uint8Array[] {
    if (opReturn[0] !== 0x6a) {
      throw new Error("Not an OP_RETURN script");
    }
    const instructions = decodeAuthenticationInstructions(opReturn.slice(1));
    if (authenticationInstructionsAreMalformed(instructions)) {
      throw new Error("Malformed push in OP_RETURN script");
    }

    const chunks: Uint8Array[] = [];
    for (const instruction of instructions) {
      const { opcode } = instruction;
      if ("data" in instruction) {
        // OP_0 is a push of empty data
        chunks.push(instruction.data);
      } else if (opcode === 0x4f) {
        chunks.push(Uint8Array.from([0x81])); // OP_1NEGATE pushes -1
      } else if (opcode >= 0x51 && opcode <= 0x60) {
        chunks.push(Uint8Array.from([opcode - 0x50])); // OP_1..OP_16
      } else {
        throw new Error(
          `Non-push opcode 0x${opcode.toString(16)} in OP_RETURN script`,
        );
      }
    }

    return chunks;
  }

  /**
   * parse - parse OP_RETURN hex data and return pushed chunks of binary data, converted to utf8 strings
   *
   * @param opReturn   Raw OP_RETURN hex data
   *
   * @returns array of binary data chunks pushed, converted to utf8 strings
   */
  public static parse(opReturnHex: string): string[] {
    return this.parseBinary(hexToBin(opReturnHex)).map((val) => binToUtf8(val));
  }
}

/** What a send returns: the signed transaction, broadcast unless `broadcast: false` was given. */
export interface SendResponse {
  txId: string;
  /** the transaction hex */
  transaction: string;
  /** the token categories among the inputs and the requested outputs */
  categories: string[];
}

export const fromUtxoId = (utxoId: string): UtxoId => {
  const [txid, vout, satoshis] = utxoId.split(DELIMITER);
  return {
    satoshis: satoshis ? BigInt(parseInt(satoshis)) : 0n,
    vout: parseInt(vout),
    txid,
  } as UtxoId;
};

export const toUtxoId = (utxo: UtxoId): string => {
  return [utxo.txid, utxo.vout].join(DELIMITER).replace(/:+$/, "");
};
