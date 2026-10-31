import { encodeCashAddress } from "@bitauth/libauth";
import type { WalletCache } from "../cache/walletCache.js";
import type { Utxo } from "../interface.js";
import { TokenSendRequest } from "../wallet/model.js";
import {
  buildP2pkhNonHdTransaction,
  getSuitableUtxos,
  placeholderPrivateKeyBin,
  prepareInputs,
} from "./Wif.js";

const category = "11".repeat(32);
describe("errors are Error objects", () => {
  const walletCache = { get: () => undefined } as unknown as WalletCache;
  const p2pkh = encodeCashAddress({
    prefix: "bchreg",
    type: "p2pkh",
    payload: new Uint8Array(20),
  }).address;
  const utxo: Utxo = {
    txid: "22".repeat(32),
    vout: 1,
    satoshis: 10_000n,
    address: p2pkh,
  };

  test("prepareInputs of a coin whose address does not decode", () => {
    expect(() =>
      prepareInputs({
        inputs: [{ ...utxo, address: "bchreg:qinvalid" }],
        compiler: undefined as any,
        signingKey: placeholderPrivateKeyBin,
        walletCache,
      }),
    ).toThrow(Error);
  });

  test("a transaction whose tokens do not add up", async () => {
    const error = await buildP2pkhNonHdTransaction({
      inputs: [utxo],
      // no input carries this category, and vout 1 cannot be its genesis
      outputs: [
        new TokenSendRequest({ cashaddr: p2pkh, category, amount: 5n }),
      ],
      signingKey: placeholderPrivateKeyBin,
      fee: 500n,
      walletCache,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/token/i);
  });
});

describe("getSuitableUtxos", () => {
  const coin = (vout: number, satoshis: bigint): Utxo => ({
    txid: "33".repeat(32),
    vout,
    satoshis,
    address: "bchreg:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  });

  test("the top-up stops once the coins cover the amount exactly", async () => {
    const coins = [coin(0, 500n), coin(1, 500n), coin(2, 500n)];
    const selected = await getSuitableUtxos(coins, 1000n, []);
    expect(selected.map((u) => u.vout)).toEqual([0, 1]);
  });
});
