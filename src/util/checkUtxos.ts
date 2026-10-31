import { Utxo, UtxoId } from "../interface.js";
import { UtxoNotAvailableError } from "../wallet/errors.js";

/** A coin's `txid:vout`, the txid lowercased: it is hex, so a caller's id in either case names the coin. */
export function toOutpoint(utxo: UtxoId): string {
  // String(): a JavaScript caller's coin without a txid names no coin, rather than throw a TypeError
  return `${String(utxo.txid).toLowerCase()}:${utxo.vout}`;
}

export function checkUtxos(utxoIds: UtxoId[], utxos: Utxo[]): Utxo[] {
  const walletUtxoMap = new Map<string, Utxo>();
  for (const utxo of utxos) {
    walletUtxoMap.set(toOutpoint(utxo), utxo);
  }

  const result: Utxo[] = [];
  for (const id of utxoIds) {
    const key = toOutpoint(id);
    const utxo = walletUtxoMap.get(key);
    if (!utxo) {
      throw new UtxoNotAvailableError(
        `Utxo ${key} in utxoIds not found in wallet`,
        {
          utxoId: key,
          reason: "not-found",
        },
      );
    }
    result.push(utxo);
  }

  return result;
}

/** The coins of `current` not in `previous`, and those of `previous` gone from `current`, by outpoint. */
export function diffUtxos(
  previous: Utxo[],
  current: Utxo[],
): { added: Utxo[]; removed: Utxo[] } {
  const previousOutpoints = new Set(previous.map(toOutpoint));
  const currentOutpoints = new Set(current.map(toOutpoint));
  return {
    added: current.filter((utxo) => !previousOutpoints.has(toOutpoint(utxo))),
    removed: previous.filter((utxo) => !currentOutpoints.has(toOutpoint(utxo))),
  };
}
