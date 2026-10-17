import * as entry from "./index.js";
import type { HDWalletOptions } from "./index.js";

test("the entry exports the HD wallet's gap limit and branch constants", () => {
  expect(entry.GAP_SIZE).toBe(20);
  expect(entry.DEFAULT_BRANCHES).toEqual([0, 1]);
  expect(entry.DEPOSIT_BRANCH).toBe(0);
  expect(entry.CHANGE_BRANCH).toBe(1);
  const options: HDWalletOptions = { branches: [...entry.DEFAULT_BRANCHES] };
  expect(options.branches).toEqual([0, 1]);
});

test("the entry keeps the storage and cache internals out", () => {
  expect(typeof entry.pruneWalletCaches).toBe("function");
  expect(typeof entry.deleteNamedWallet).toBe("function");
  for (const name of [
    "StorageProvider",
    "purgeWalletCache",
    "walletCacheIdFromWalletId",
    "deriveWalletCacheId",
    "stringify",
    "parse",
    "HDWalletCache",
    "SingleAddressWalletCache",
    "IndexedDbCache",
  ]) {
    expect(entry, name).not.toHaveProperty(name);
  }
  for (const name of [
    "UseLocalStorageCache",
    "UseMemoryCache",
    "DefaultIpfsGateway",
    "setIpfsGateway",
  ]) {
    expect(entry.Config, name).not.toHaveProperty(name);
  }
});

test("the entry exports the utilities Cashonize uses and none of the removed ones", () => {
  for (const name of [
    "convert",
    "decodeHeader",
    "ExchangeRate",
    "getAddrsByXpubKey",
    "getXPubKey",
    "MAX_OP_RETURN_BYTES",
    "NFTCapability",
    "NetworkType",
    "SignedMessage",
  ]) {
    expect(entry).toHaveProperty(name);
  }
  for (const name of [
    "amountInSatoshi",
    "atob",
    "binToHex",
    "btoa",
    "checkUtxos",
    "convertAddress",
    "convertObject",
    "delay",
    "deriveCashaddr",
    "deriveHdPaths",
    "derivePublicKeyHash",
    "derivePublicNodeCashaddr",
    "derivedNetwork",
    "deriveTokenaddr",
    "getAddrsByXpubKeyObject",
    "getRuntimePlatform",
    "getWeakRandomInt",
    "getXPubKeys",
    "getXpubKeyInfo",
    "getXpubKeyInfoObject",
    "hash160",
    "hexToBin",
    "isTokenaddr",
    "isValidAddress",
    "libauth",
    "Network",
    "RuntimePlatform",
    "sanitizeAddress",
    "sanitizeUnit",
    "sumTokenAmounts",
    "sumUtxoValue",
    "toBch",
    "toCashaddr",
    "toCurrency",
    "toSat",
    "toTokenaddr",
    "UnitEnum",
    "XPubKey",
  ]) {
    expect(entry).not.toHaveProperty(name);
  }
});

test("SignedMessage has only the static sign and verify", () => {
  expect(Object.getOwnPropertyNames(entry.SignedMessage.prototype)).toEqual([
    "constructor",
  ]);
});
