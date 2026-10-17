import { encodeCashAddress, encodeTransactionOutput } from "@bitauth/libauth";
import type { WalletCache } from "../cache/walletCache.js";
import type { Utxo } from "../interface.js";
import { TokenSendRequest } from "../wallet/model.js";
import {
  buildP2pkhNonHdTransaction,
  placeholderPrivateKeyBin,
  prepareInputs,
  prepareTokenOutputs,
} from "./Wif.js";

const category = "11".repeat(32);
const cashaddr = "bchreg:zpttdv3qg2usm4nm7talhxhl05mlhms3ysjm0q59vu";

describe("prepareTokenOutputs", () => {
  test("gives an NFT without a commitment empty commitment bytes", () => {
    // an untyped caller can leave out the commitment
    const request = new TokenSendRequest({
      cashaddr,
      category,
      nft: { capability: "none" } as any,
    });
    const output = prepareTokenOutputs(request);
    expect(output.token!.nft!.commitment).toEqual(Uint8Array.of());
    expect(() => encodeTransactionOutput(output)).not.toThrow();
  });
});

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
