// config
export { Config } from "./config.js";
export type { WalletDbEntryI } from "./db/interface.js";
// cache
export { pruneWalletCaches } from "./cache/walletCache.js";
// Enum
export { NetworkType } from "./enum.js";
// history
export { getHistory } from "./history/getHistory.js";
export * from "./history/interface.js";
// interfaces
export { NFTCapability } from "./interface.js";
export type { HeaderI, HexHeaderI, TokenI, TxI, Utxo } from "./interface.js";
export type {
  SignedMessageResponseI,
  VerifyMessageResponseI,
} from "./message/interface.js";
// message
export { SignedMessage } from "./message/signed.js";
// provider
export { DefaultProvider } from "./network/configuration.js";
// network
export {
  createProvider,
  getNetworkProvider,
  removeGlobalProvider,
  setGlobalProvider,
} from "./network/default.js";
export { default as ElectrumNetworkProvider } from "./network/ElectrumNetworkProvider.js";
export { BroadcastRejectedError } from "./network/errors.js";
export { ElectrumTimeoutError } from "./network/ElectrumTransport.js";
export type { ElectrumTransportOptions } from "./network/ElectrumTransport.js";
export type {
  ElectrumRawTransaction,
  ElectrumRawTransactionVinWithValues,
  ElectrumRawTransactionWithInputValues,
} from "./network/interface.js";
// xpub utilities
export { getAddrsByXpubKey } from "./util/getAddrsByXpubKey.js";
export { getXPubKey } from "./util/getXPubKey.js";
export { MAX_OP_RETURN_BYTES } from "./constant.js";
// rates and conversion
export { ExchangeRate } from "./rate/ExchangeRate.js";
export type {
  ExchangeRateOptions,
  ExchangeRateQuote,
} from "./rate/ExchangeRate.js";
export { convert } from "./util/convert.js";
// utils
export { decodeHeader } from "./util/header.js";
// wallets - explicit exports for tree-shaking
export {
  BaseWallet,
  deleteNamedWallet,
  getNamedWalletId,
} from "./wallet/Base.js";
export {
  InsufficientFundsError,
  InvalidRequestError,
  TokenBurnError,
  UtxoNotAvailableError,
} from "./wallet/errors.js";
export {
  CHANGE_BRANCH,
  DEFAULT_BRANCHES,
  DEPOSIT_BRANCH,
  GAP_SIZE,
  HDWallet,
  RegTestHDWallet,
  TestNetHDWallet,
} from "./wallet/HDWallet.js";
export type { HDWalletOptions } from "./wallet/HDWallet.js";
export * from "./wallet/interface.js";
export {
  OpReturnData,
  TokenBurnRequest,
  TokenGenesisRequest,
  TokenMintRequest,
  TokenSendRequest,
} from "./wallet/model.js";
export type {
  SendRequest,
  SendRequestType,
  SendResponse,
} from "./wallet/model.js";
// transaction utilities
export {
  decodeTransaction,
  type DecodeTransactionOptions,
  getTransactionHash,
} from "./wallet/Util.js";
export {
  RegTestWatchWallet,
  TestNetWatchWallet,
  WatchWallet,
} from "./wallet/Watch.js";
export {
  RegTestWallet,
  RegTestWifWallet,
  TestNetWallet,
  TestNetWifWallet,
  Wallet,
  WifWallet,
} from "./wallet/Wif.js";
