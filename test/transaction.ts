import { decodeTransaction, hexToBin } from "@bitauth/libauth";
import type ElectrumNetworkProvider from "../src/network/ElectrumNetworkProvider.js";

/** A transaction read from the provider, decoded with libauth. */
export async function getTransaction(
  provider: ElectrumNetworkProvider,
  txid: string,
) {
  const hex = await provider.getRawTransaction(txid);
  const transaction = decodeTransaction(hexToBin(hex));
  if (typeof transaction === "string") throw new Error(transaction);
  return transaction;
}
