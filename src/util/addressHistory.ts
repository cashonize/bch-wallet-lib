import { binToHex, sha256, utf8ToBin } from "@bitauth/libauth";
import type { TxI, Utxo } from "../interface.js";

/**
 * The electrum status of an address with this history, in the server's order: the sha256 of
 * `tx_hash:height:` concatenated over it, null for an empty history.
 */
export function historyStatus(history: TxI[]): string | null {
  if (history.length === 0) return null;
  const concatenated = history
    .map((tx) => `${tx.tx_hash}:${tx.height}:`)
    .join("");
  return binToHex(sha256.hash(utf8ToBin(concatenated)));
}

/** The highest confirmed height in a history, 0 when none is confirmed. */
export function highestConfirmedHeight(history: TxI[]): number {
  return history.reduce(
    (max, tx) => (tx.height > 0 ? Math.max(max, tx.height) : max),
    0,
  );
}

/**
 * The history after fetching it from `fromHeight` on: the cached confirmed entries below that
 * height, then the fetched ones, which keeps the server's order.
 */
export function mergeHistory(
  cached: TxI[],
  fromHeight: number,
  fetched: TxI[],
): TxI[] {
  const merged = cached.filter((tx) => tx.height > 0 && tx.height < fromHeight);
  const seen = new Set(merged.map((tx) => tx.tx_hash));
  for (const tx of fetched) {
    if (!seen.has(tx.tx_hash)) {
      seen.add(tx.tx_hash);
      merged.push(tx);
    }
  }
  return merged;
}

/**
 * An address's coins and history for an announced status, the history fetched from `fromHeight`
 * on and merged with the cached one. When that does not hash to the status, as after a reorg
 * below `fromHeight`, the whole history is fetched once more. `matches` is false when that one
 * does not hash to the status either, the address having changed meanwhile: the caller then
 * keeps its previous status, so that the next notification fetches again.
 *
 * A check of consistency, not of trust: a server can serve any history matching its own status.
 */
export async function fetchAddressState(
  fetch: (fromHeight: number) => Promise<[Utxo[], TxI[]]>,
  status: string,
  cached: TxI[],
  fromHeight: number,
): Promise<{ utxos: Utxo[]; history: TxI[]; matches: boolean }> {
  const [utxos, fetched] = await fetch(fromHeight);
  const history = mergeHistory(cached, fromHeight, fetched);
  const matches = historyStatus(history) === status;
  // a history fetched from 0 already is the whole one
  if (matches || fromHeight === 0) return { utxos, history, matches };
  const [allUtxos, all] = await fetch(0);
  return {
    utxos: allUtxos,
    history: all,
    matches: historyStatus(all) === status,
  };
}
