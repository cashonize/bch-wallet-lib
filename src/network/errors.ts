// BCHN's answers for a transaction its mempool or chain already holds
const ALREADY_KNOWN_REASONS = [
  "txn-already-known",
  "txn-already-in-mempool",
  "transaction already in block chain",
];

/**
 * Thrown when a failover provider finds no server to start on: `failures` holds each server tried
 * and why it was passed over (`server` is undefined for "the device is offline").
 */
export class ElectrumConnectError extends Error {
  readonly failures: { server: string | undefined; reason: string }[];

  constructor(failures: { server: string | undefined; reason: string }[]) {
    const list = failures
      .map(({ server, reason }) => (server ? `${server}: ${reason}` : reason))
      .join("; ");
    super(`Could not connect to an electrum server (${list}).`);
    this.name = "ElectrumConnectError";
    this.failures = failures;
  }
}

/**
 * Thrown when the server answers a broadcast with an error. `reason` is the node's reject reason
 * (BCHN's, e.g. "txn-mempool-conflict", "Missing inputs", "dust"), `txid` the refused
 * transaction's id and `cause` the server's error. The message is the server's own. A broadcast that times out or
 * loses its connection is no refusal, as the transaction may have reached the node all the same.
 *
 * `alreadyKnown` is set when the node's answer is that it already holds the transaction, in its
 * mempool or in a block: that is no refusal, an earlier broadcast of it went through.
 * `sendRawTransaction`, and so every send, returns the txid for that answer instead of throwing.
 */
export class BroadcastRejectedError extends Error {
  readonly reason: string;
  readonly txid?: string;
  readonly alreadyKnown: boolean;

  constructor(
    message: string,
    { reason, txid, cause }: { reason: string; txid?: string; cause?: unknown },
  ) {
    super(message, { cause });
    this.name = "BroadcastRejectedError";
    this.reason = reason;
    this.txid = txid;
    this.alreadyKnown = ALREADY_KNOWN_REASONS.includes(reason);
  }
}

/**
 * Thrown when a broadcast's outcome is unknown and a lookup of the transaction then failed: the
 * broadcast timed out or lost its connection, or the server accepted it but did not report it. The
 * transaction may or may not have reached the network. `txid` is its id, `transaction` its signed
 * hex, and `cause` the error of the broadcast or of the lookup.
 *
 * Broadcasting `transaction` again is safe and settles the outcome: the node either takes it or
 * answers that it already holds it, which `sendRawTransaction` returns as success. Building a new
 * transaction instead may spend other coins and pay twice.
 */
export class BroadcastTimeoutError extends Error {
  readonly txid: string;
  readonly transaction: string;

  constructor(
    message: string,
    {
      txid,
      transaction,
      cause,
    }: { txid: string; transaction: string; cause?: unknown },
  ) {
    super(message, { cause });
    this.name = "BroadcastTimeoutError";
    this.txid = txid;
    this.transaction = transaction;
  }
}

/**
 * The code of the JSON-RPC error a server answered with, or undefined for an error of the
 * connection (lost, closed, timed out). electrum-cash gives the server's error object as the
 * error's cause, mem-cash's transport puts the code on the error itself. A JSON-RPC error carries
 * a message next to its code; a DOMException or a CloseEvent has a numeric code too, but is the
 * connection failing, after which the transaction may still have reached the node.
 */
export function serverErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  if (isRpcError(error.cause)) return error.cause.code;
  if (isRpcError(error)) return error.code;
  return undefined;
}

function isRpcError(
  value: unknown,
): value is { code: number; message: string } {
  if (typeof value !== "object" || value === null) return false;
  if (typeof DOMException !== "undefined" && value instanceof DOMException) {
    return false;
  }
  const { code, message } = value as { code?: unknown; message?: unknown };
  return typeof code === "number" && typeof message === "string";
}

// Fulcrum and ElectrumX wrap the node's answer as "<WRAPPER>\n\n<answer>\n", ElectrumX followed by
// the raw transaction in brackets
const WRAPPER = "the transaction was rejected by network rules.";

/**
 * The reject reason in a server's refusal of a broadcast. The node's answer is BCHN's
 * FormatStateMessage, "<reason>[, <debug message>] (code <n>)", or a bare message such as
 * "Missing inputs".
 */
export function parseRejection(message: string): string {
  let answer = message.trim();
  if (answer.startsWith(WRAPPER)) answer = answer.slice(WRAPPER.length).trim();
  answer = answer.split("\n")[0].trim();
  answer = answer.replace(/ \(code -?\d+\)$/, "");
  return withoutDebugMessage(answer);
}

// A reason can carry its own detail in parentheses, e.g. "mandatory-script-verify-flag-failed (…)",
// which may hold commas; the debug message follows the first comma outside of it
function withoutDebugMessage(answer: string): string {
  let depth = 0;
  for (let i = 0; i < answer.length; i++) {
    const char = answer[i];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) return answer.slice(0, i);
  }
  return answer;
}
