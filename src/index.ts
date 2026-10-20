// config
export { Config } from "./config.js";
export type { WalletDbEntryI } from "./db/interface.js";
// db
export { default as StorageProvider } from "./db/StorageProvider.js";
// EncryptedStorageProvider is available via the sub-entry "mainnet-js/encrypted-storage"
// so it stays out of the main bundle for consumers that don't use it.
// Enum
export { NetworkType, UnitEnum } from "./enum.js";
// history
export { getHistory } from "./history/getHistory.js";
export * from "./history/interface.js";
// interfaces
export * from "./interface.js";
export type {
  SignedMessageResponseI,
  VerifyMessageResponseI,
} from "./message/interface.js";
// message
export { SignedMessage } from "./message/signed.js";
export {
  disconnectProviders,
  initProvider,
  initProviders,
} from "./network/Connection.js";
// provider
export { DefaultProvider } from "./network/configuration.js";
// network
export {
  createProvider,
  getGlobalProvider,
  getNetworkProvider,
  removeGlobalProvider,
  setGlobalProvider,
} from "./network/default.js";
export { default as ElectrumNetworkProvider } from "./network/ElectrumNetworkProvider.js";
export type {
  ElectrumRawTransaction,
  ElectrumRawTransactionVinWithValues,
  ElectrumRawTransactionWithInputValues,
} from "./network/interface.js";
export type { default as NetworkProvider } from "./network/NetworkProvider.js";
// xpub utilities
export { getAddrsByXpubKey } from "./util/getAddrsByXpubKey.js";
export { getXPubKey } from "./util/getXPubKey.js";
// utils
export * from "./util/index.js";
// wallets - explicit exports for tree-shaking
export { BaseWallet } from "./wallet/Base.js";
export { WalletTypeEnum } from "./wallet/enum.js";
export {
  HDWallet,
  RegTestHDWallet,
  TestNetHDWallet,
} from "./wallet/HDWallet.js";
export * from "./wallet/interface.js";
export * from "./wallet/model.js";
// transaction utilities
export { getTransactionHash } from "./util/transaction.js";
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
