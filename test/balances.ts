import type { Utxo } from "../src/interface.js";
import { delay } from "../src/util/delay.js";

// Balances read from one getUtxos() snapshot, as a caller of the library computes them
interface UtxoSource {
  getUtxos(): Promise<Utxo[]>;
}
interface BalanceSource {
  getBalance(): Promise<bigint>;
}

/** The wallet's token coins, of one category when given */
export async function getTokenUtxos(
  wallet: UtxoSource,
  category?: string,
): Promise<Utxo[]> {
  const utxos = await wallet.getUtxos();
  return utxos.filter((utxo) =>
    category ? utxo.token?.category === category : utxo.token,
  );
}

/** The wallet's fungible token amount of a category */
export async function getTokenBalance(
  wallet: UtxoSource,
  category: string,
): Promise<bigint> {
  const utxos = await getTokenUtxos(wallet, category);
  return utxos.reduce((sum, utxo) => sum + (utxo.token?.amount ?? 0n), 0n);
}

/** The number of NFTs of a category the wallet holds */
export async function getNftTokenBalance(
  wallet: UtxoSource,
  category: string,
): Promise<number> {
  const utxos = await getTokenUtxos(wallet, category);
  return utxos.filter((utxo) => utxo.token?.nft !== undefined).length;
}

async function poll<T>(
  read: () => Promise<T>,
  reached: (value: T) => boolean,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (reached(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting, last value ${String(value)}`);
    }
    await delay(50);
  }
}

/** Resolves with the balance once it is at least `value` */
export function waitForBalance(
  wallet: BalanceSource,
  value: bigint,
  timeout = 10_000,
): Promise<bigint> {
  return poll(
    () => wallet.getBalance(),
    (balance) => balance >= value,
    timeout,
  );
}

/** Resolves with the token balance of a category once it is at least `amount` */
export function waitForTokenBalance(
  wallet: UtxoSource,
  category: string,
  amount: bigint,
  timeout = 10_000,
): Promise<bigint> {
  return poll(
    () => getTokenBalance(wallet, category),
    (balance) => balance >= amount,
    timeout,
  );
}
