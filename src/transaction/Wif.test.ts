import {
  encodeCashAddress,
  encodeTransaction,
  encodeTransactionOutput,
  hexToBin,
} from "@bitauth/libauth";
import type { WalletCache } from "../cache/walletCache.js";
import type { Utxo } from "../interface.js";
import { TokenSendRequest } from "../wallet/model.js";
import {
  buildP2pkhNonHdTransaction,
  placeholderPrivateKeyBin,
  prepareInputs,
  prepareTokenOutputs,
  signUnsignedTransaction,
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
  const tx = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin("22".repeat(32)),
        outpointIndex: 0,
        sequenceNumber: 0,
        unlockingBytecode: Uint8Array.of(),
      },
    ],
    outputs: [{ lockingBytecode: Uint8Array.of(0x51), valueSatoshis: 1000n }],
  });
  const sourceOutputs = [
    {
      outpointTransactionHash: hexToBin("22".repeat(32)),
      outpointIndex: 0,
      sequenceNumber: 0,
      unlockingBytecode: Uint8Array.of(),
      lockingBytecode: Uint8Array.of(0x51),
      valueSatoshis: 2000n,
    },
  ];

  test("signUnsignedTransaction of a malformed transaction", async () => {
    const error = await signUnsignedTransaction(
      "00",
      sourceOutputs,
      placeholderPrivateKeyBin,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Error reading transaction/);
  });

  test("signUnsignedTransaction with a key that cannot sign", async () => {
    const error = await signUnsignedTransaction(
      tx,
      sourceOutputs,
      new Uint8Array(32),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^Could not sign the transaction: .*not a valid Secp256k1 private key/,
    );
    // libauth's generation errors, per input
    expect((error as Error).cause).toMatchObject([{ index: 0 }]);
  });

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
