import type { Output } from "@bitauth/libauth";
import { NFTCapability, Utxo } from "../interface.js";
import { TokenBurnError } from "../wallet/errors.js";
import { TokenSendRequest } from "../wallet/model.js";
import { checkTokenConservation } from "./tokenConservation.js";
import { prepareTokenOutputs } from "./Wif.js";

const category = "11".repeat(32);
const other = "22".repeat(32);
const address = "bchreg:zpttdv3qg2usm4nm7talhxhl05mlhms3ysjm0q59vu";

type Nft = { capability: NFTCapability; commitment: string };

let vout = 0;
const input = (amount: bigint, nft?: Nft, cat = category): Utxo => ({
  txid: "aa".repeat(32),
  vout: vout++,
  satoshis: 1000n,
  address,
  token: { category: cat, amount, nft },
});
const output = (amount: bigint, nft?: Nft, cat = category): Output =>
  prepareTokenOutputs(
    new TokenSendRequest({ cashaddr: address, category: cat, amount, nft }),
  );

const burnError = (check: () => void) => {
  let error: unknown;
  try {
    check();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(TokenBurnError);
  return error as TokenBurnError;
};

const immutable = (commitment: string): Nft => ({
  capability: NFTCapability.none,
  commitment,
});
const mutable = (commitment: string): Nft => ({
  capability: NFTCapability.mutable,
  commitment,
});
const minting = (commitment: string): Nft => ({
  capability: NFTCapability.minting,
  commitment,
});

describe("checkTokenConservation", () => {
  test("passes fungible tokens that all come back, split or merged", () => {
    expect(() =>
      checkTokenConservation(
        [input(60n), input(40n), input(5n, undefined, other)],
        [output(30n), output(70n), output(5n, undefined, other)],
        {},
      ),
    ).not.toThrow();
  });

  test("refuses fungible tokens missing from the outputs", () => {
    const error = burnError(() =>
      checkTokenConservation(
        [input(100n), input(5n, undefined, other)],
        [output(100n)],
        {},
      ),
    );
    expect(error.category).toBe(other);
    expect(error.amount).toBe(5n);
    expect(error.nft).toBeUndefined();
  });

  test("lets an allowed fungible burn through, and refuses what goes beyond it", () => {
    const inputs = [input(100n)];
    const allowed = { fungible: { [category]: 10n } };
    expect(() =>
      checkTokenConservation(inputs, [output(90n)], allowed),
    ).not.toThrow();
    const error = burnError(() =>
      checkTokenConservation(inputs, [output(85n)], allowed),
    );
    expect(error.amount).toBe(5n);
  });

  test("refuses an immutable NFT that does not come back as it was", () => {
    const error = burnError(() =>
      checkTokenConservation(
        [input(0n, immutable("01")), input(0n, immutable("02"))],
        [output(0n, immutable("01")), output(0n, immutable("03"))],
        {},
      ),
    );
    expect(error.category).toBe(category);
    expect(error.amount).toBe(0n);
    expect(error.nft).toEqual(immutable("02"));
  });

  test("refuses an NFT whose fungible tokens come back on their own", () => {
    const error = burnError(() =>
      checkTokenConservation([input(50n, immutable("01"))], [output(50n)], {}),
    );
    expect(error.nft).toEqual(immutable("01"));
  });

  test("lets a mutable NFT change its commitment or become immutable", () => {
    expect(() =>
      checkTokenConservation(
        [input(0n, mutable("01")), input(0n, mutable("02"))],
        [output(0n, mutable("0a")), output(0n, immutable("0b"))],
        {},
      ),
    ).not.toThrow();
  });

  test("refuses a mutable NFT that a spent minting NFT's new NFT replaces", () => {
    const error = burnError(() =>
      checkTokenConservation(
        [input(0n, minting("")), input(0n, mutable("01"))],
        [output(0n, minting("")), output(0n, mutable("02"))],
        {},
      ),
    );
    expect(error.nft).toEqual(mutable("01"));
  });

  test("lets a minting NFT change its commitment and mint more", () => {
    expect(() =>
      checkTokenConservation(
        [input(0n, minting("01"))],
        [
          output(0n, minting("02")),
          output(0n, immutable("03")),
          output(0n, mutable("04")),
        ],
        {},
      ),
    ).not.toThrow();
  });

  test("refuses a minting NFT that comes back as another capability", () => {
    const error = burnError(() =>
      checkTokenConservation(
        [input(0n, minting("01"))],
        [output(0n, mutable("01"))],
        {},
      ),
    );
    expect(error.nft).toEqual(minting("01"));
  });

  test("lets an allowed NFT burn through, of that NFT only", () => {
    const inputs = [input(0n, immutable("01")), input(0n, immutable("02"))];
    const allowed = { nfts: [{ category, ...immutable("01") }] };
    expect(() =>
      checkTokenConservation(inputs, [output(0n, immutable("02"))], allowed),
    ).not.toThrow();
    const error = burnError(() =>
      checkTokenConservation(inputs, [output(0n, immutable("01"))], allowed),
    );
    expect(error.nft).toEqual(immutable("02"));
  });

  test("leaves tokens created from nothing to the consensus check", () => {
    expect(() =>
      checkTokenConservation([], [output(10n, immutable("01"), other)], {}),
    ).not.toThrow();
  });
});
