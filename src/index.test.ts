import * as entry from "./index.js";

test("the entry exports the HD wallet's gap limit and branch constants", () => {
  expect(entry.GAP_SIZE).toBe(20);
  expect(entry.DEPOSIT_BRANCH).toBe(0);
  expect(entry.CHANGE_BRANCH).toBe(1);
});

test("the entry leaves out the wallet classes and helpers that are internal or removed", () => {
  for (const name of [
    "RegTestWallet",
    "RegTestHDWallet",
    "WatchWallet",
    "TestNetWatchWallet",
    "RegTestWatchWallet",
    "WifWallet",
    "TestNetWifWallet",
    "RegTestWifWallet",
    "DEFAULT_BRANCHES",
    "WalletTypeEnum",
    "createWallet",
    "walletFromId",
    "decodeTransaction",
  ]) {
    expect(entry).not.toHaveProperty(name);
  }
  expect(typeof entry.namedWalletExists).toBe("function");
});

test("the entry keeps the storage and cache internals out", () => {
  expect(typeof entry.pruneWalletCaches).toBe("function");
  expect(typeof entry.deleteNamedWallet).toBe("function");
  expect(typeof entry.saveNamedWallet).toBe("function");
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
    "decodeWif",
    "InvalidWalletIdError",
    "InvalidWifError",
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

test("the entry exports the network, history and rate surface Cashonize uses and none of the internals", () => {
  for (const name of [
    "BroadcastRejectedError",
    "createProvider",
    "DefaultProvider",
    "ElectrumNetworkProvider",
    "ElectrumTimeoutError",
    "ExchangeRate",
    "getHistory",
    "getNetworkProvider",
    "removeGlobalProvider",
    "setGlobalProvider",
  ]) {
    expect(entry).toHaveProperty(name);
  }
  for (const name of [
    "disconnectProviders",
    "ElectrumTransport",
    "getExchangeRatePromise",
    "getGlobalProvider",
    "getUsdRate",
    "initProvider",
    "initProviders",
    "mine",
  ]) {
    expect(entry, name).not.toHaveProperty(name);
  }
  expect(Object.getOwnPropertyNames(entry.ExchangeRate)).not.toContain("get");
  expect(Object.getOwnPropertyNames(entry.ExchangeRate)).toContain("getQuote");
  for (const name of ["DefaultCurrency", "MaxRelayFeePerByte"]) {
    expect(entry.Config, name).not.toHaveProperty(name);
  }
});

test("the entry keeps the spend models' internals off its API", () => {
  for (const name of [
    "SendRequest",
    "SendResponse",
    "asSendRequestObject",
    "fromUtxoId",
    "toUtxoId",
    "toTokenCategory",
    "toTokenNft",
    "toTokenAmount",
    "checkTokenOutput",
    "checkGenesisRequest",
    "checkMintRequest",
    "checkBurnRequest",
    "opReturnFromBytes",
    "FeePaidByEnum",
    "WalletTypeEnum",
  ]) {
    expect(entry).not.toHaveProperty(name);
  }
  expect(entry.OpReturnData).toBeDefined();
  expect(entry.TokenSendRequest).toBeDefined();
});
