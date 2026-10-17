import { Utxo, UtxoId } from "../interface.js";
import { UtxoNotAvailableError } from "../wallet/errors.js";

export function checkUtxos(utxoIds: UtxoId[], utxos: Utxo[]): Utxo[] {
  const walletUtxoMap = new Map<string, Utxo>();
  for (const utxo of utxos) {
    walletUtxoMap.set(`${utxo.txid}:${utxo.vout}`, utxo);
  }

  const result: Utxo[] = [];
  for (const id of utxoIds) {
    const key = `${id.txid}:${id.vout}`;
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
