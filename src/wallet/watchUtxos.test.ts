import { randomUtxo } from "@paryonusd/mem-cash";
import { Network, Utxo } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import { MockNetworkProvider } from "../network/MockNetworkProvider.js";
import { toOutpoint } from "../util/checkUtxos.js";
import { delay } from "../util/delay.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWallet } from "./Wif.js";

type UtxoChange = { utxos: Utxo[]; added: Utxo[]; removed: Utxo[] };

const miner = "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0";
let provider: MockNetworkProvider;

beforeEach(async () => {
  provider = new MockNetworkProvider();
  await provider.connect();
  setGlobalProvider(Network.REGTEST, provider);
});
afterEach(() => {
  removeGlobalProvider(Network.REGTEST);
});

async function fund(address: string, satoshis: bigint): Promise<Utxo> {
  const utxo = { ...randomUtxo({ vout: 0, satoshis }), height: 100 };
  await provider.addUtxo(address, utxo);
  // the mock chain derives the txid from the transaction it makes up
  const coins = await provider.getUtxos(address);
  return coins.find((coin) => coin.satoshis === satoshis)!;
}

const outpoints = (utxos: Utxo[]) => utxos.map(toOutpoint).sort();

async function changesUntil(changes: UtxoChange[], count: number) {
  await vi.waitFor(() => expect(changes).toHaveLength(count));
  // and no more than that
  await delay(150);
  expect(changes).toHaveLength(count);
  return changes[count - 1];
}

test("a single-address wallet reports its coins, then each coin added or removed, and a confirmation as neither", async () => {
  const wallet = await RegTestWallet.newRandom();
  const first = await fund(wallet.cashaddr, 5_000n);
  const changes: UtxoChange[] = [];
  await wallet.watchUtxos((change) => changes.push(change));

  let change = await changesUntil(changes, 1);
  expect(outpoints(change.utxos)).toEqual([toOutpoint(first)]);
  expect(change.added).toEqual([]);
  expect(change.removed).toEqual([]);

  const second = await fund(wallet.cashaddr, 7_000n);
  change = await changesUntil(changes, 2);
  expect(outpoints(change.added)).toEqual([toOutpoint(second)]);
  expect(change.removed).toEqual([]);

  const other = await RegTestWallet.newRandom();
  const { txId } = await wallet.send(
    { cashaddr: other.cashaddr, value: 1_000n },
    { utxoIds: [first] },
  );
  change = await changesUntil(changes, 3);
  expect(change.added.map((utxo) => utxo.txid)).toEqual([txId]);
  expect(change.added[0].height).toBe(0);
  expect(outpoints(change.removed)).toEqual([toOutpoint(first)]);

  await provider.mine(miner, 1);
  change = await changesUntil(changes, 4);
  expect(change.added).toEqual([]);
  expect(change.removed).toEqual([]);
  const confirmed = change.utxos.find((utxo) => utxo.txid === txId)!;
  expect(confirmed.height).toBeGreaterThan(0);

  await other.stop();
  await wallet.stop();
});

test("a failed read after the first goes to onError, and the next status change reads again", async () => {
  const wallet = await RegTestWallet.newRandom();
  const changes: UtxoChange[] = [];
  const errors: unknown[] = [];
  await wallet.watchUtxos((change) => changes.push(change), {
    onError: (error) => errors.push(error),
  });
  await changesUntil(changes, 1);

  const failure = new Error("server refused the read");
  vi.spyOn(wallet, "getUtxos").mockRejectedValueOnce(failure);
  await fund(wallet.cashaddr, 5_000n);
  await vi.waitFor(() => expect(errors).toEqual([failure]));
  expect(changes).toHaveLength(1);

  const second = await fund(wallet.cashaddr, 7_000n);
  const change = await changesUntil(changes, 2);
  expect(outpoints(change.utxos)).toHaveLength(2);
  expect(change.added.map(toOutpoint)).toContain(toOutpoint(second));

  await wallet.stop();
});

test("an HD wallet folds the status changes of one debounce into one change", async () => {
  const wallet = await RegTestHDWallet.newRandom();
  await wallet["watchPromise"];
  const changes: UtxoChange[] = [];
  await wallet.watchUtxos((change) => changes.push(change));
  await changesUntil(changes, 1);
  expect(changes[0].utxos).toEqual([]);

  const [first, second] = await Promise.all([
    fund(wallet.getDepositAddress(0), 1_000n),
    fund(wallet.getDepositAddress(1), 2_000n),
  ]);
  const change = await changesUntil(changes, 2);
  expect(outpoints(change.added)).toEqual(outpoints([first, second]));
  expect(change.removed).toEqual([]);
  await wallet.stop();
});
