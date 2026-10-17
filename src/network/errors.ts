/**
 * Thrown when the server refuses to broadcast a transaction. `reason` is the node's reject reason
 * (BCHN's, e.g. "txn-mempool-conflict", "Missing inputs", "dust"), `code` BCHN's reject code when
 * the server passes one on (18 for "txn-mempool-conflict"), `txid` the refused transaction's id and
 * `cause` the server's error. The message is the server's own. A broadcast that times out is an
 * `ElectrumTimeoutError` instead, as the transaction may have reached the node all the same.
 */
export class BroadcastRejectedError extends Error {
  readonly reason: string;
  readonly code?: number;
  readonly txid?: string;

  constructor(
    message: string,
    {
      reason,
      code,
      txid,
      cause,
    }: { reason: string; code?: number; txid?: string; cause?: unknown },
  ) {
    super(message, { cause });
    this.name = "BroadcastRejectedError";
    this.reason = reason;
    this.code = code;
    this.txid = txid;
  }
}

/**
 * The code of the JSON-RPC error a server answered with, or undefined for an error of the
 * connection (lost, closed, timed out). electrum-cash gives the server's error object as the
 * error's cause, mem-cash's transport puts the code on the error itself.
 */
export function serverErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = error.cause as { code?: unknown } | undefined;
  if (typeof cause?.code === "number") return cause.code;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  return undefined;
}

// Fulcrum and ElectrumX wrap the node's answer as "<WRAPPER>\n\n<answer>\n", ElectrumX followed by
// the raw transaction in brackets
const WRAPPER = "the transaction was rejected by network rules.";

/**
 * The reject reason and code in a server's refusal of a broadcast. The node's answer is BCHN's
 * FormatStateMessage, "<reason>[, <debug message>] (code <n>)", or a bare message such as
 * "Missing inputs".
 */
export function parseRejection(message: string): {
  reason: string;
  code?: number;
} {
  let answer = message.trim();
  if (answer.startsWith(WRAPPER)) answer = answer.slice(WRAPPER.length).trim();
  answer = answer.split("\n")[0].trim();

  let code: number | undefined;
  const coded = / \(code (-?\d+)\)$/.exec(answer);
  if (coded) {
    code = Number(coded[1]);
    answer = answer.slice(0, coded.index);
  }
  return { reason: withoutDebugMessage(answer), code };
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
