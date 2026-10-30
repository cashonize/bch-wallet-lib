# Public API and why each part exists

Every name the package exports, every public class member and every option group, with who needs it. Checked against the Cashonize migration branch (`b2870ea`, built on this library's `620ed08` of the `archive/dev-history` branch). Cashonize sites are file names; `docs/consumer-notes.md` says why Cashonize uses them.

A new export needs a row here and a real consumer. Rows marked **no consumer** have neither a Cashonize use nor a reason inside the library to be public: they are candidates for removal. "Planned" means a Cashonize change named in `docs/consumer-notes.md` section 4 that the branch has not made yet.

Entry points (`package.json` `exports`): `@cashonize/bch-wallet-lib` and `@cashonize/bch-wallet-lib/indexeddb`.

## `@cashonize/bch-wallet-lib`

### Wallet classes and factories

| Export or member                                   | Who needs it                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Wallet`, `TestNetWallet`                          | Single-address wallets: `interfaces.ts` (`WalletType`), `walletUtils.ts`, `utils.ts`, `sweepPrivateKey.vue`                       |
| `HDWallet`, `TestNetHDWallet`                      | HD wallets: `interfaces.ts`, `walletUtils.ts`, `store.ts`, `addressRows.ts`; `instanceof HDWallet` tells the kind                 |
| `BaseWallet`                                       | `store.ts` sets `BaseWallet.StorageProvider`; Cashonize tests type wallets with it                                                |
| `static fromId(walletId, options?)` (both classes) | Loads a stored id: `utils.ts` `loadWalletFromId`                                                                                  |
| `Wallet.fromWIF(wif, options?)`                    | The sweep's temporary wallet: `sweepPrivateKey.vue`                                                                               |
| `static newRandom(name?, options?)` (both classes) | **No consumer**: Cashonize creates wallets with `named`; only the library's tests call it                                         |
| `static named(name, options?)`                     | Creates the wallet of a new name: `walletUtils.ts` create and import flows                                                        |
| `static replaceNamed(name, walletId, options?)`    | `walletUtils.ts` stores the chipnet copy and an import's ids; planned to become `saveNamedWallet`, after which it has no consumer |
| `WalletFactoryOptions` (`provider`)                | The wallet starts on that provider and no global one is made; planned to replace `DefaultProvider.servers` in `store.ts`          |
| `toDbString()`                                     | `walletUtils.ts` derives the chipnet id from the mainnet one                                                                      |

### Named wallet storage

| Export or member                           | Who needs it                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `getNamedWalletId(name, dbName?)`          | `store.ts` `loadExistingWallet`, loading without `named`'s create       |
| `namedWalletExists(name, dbName?)`         | Planned: replaces `dbUtils.ts` `namedWalletExistsInDb`                  |
| `saveNamedWallet(name, walletId, dbName?)` | Planned: replaces `replaceNamed(…).stop()` in `walletUtils.ts`          |
| `deleteNamedWallet(name, dbName?)`         | `store.ts` wallet deletion, both databases                              |
| `pruneWalletCaches(keepWalletIds)`         | `dbUtils.ts` start-up prune of cache records with no row                |
| `BaseWallet.StorageProvider` (static)      | `store.ts` sets `IndexedDBProvider`; every named-wallet helper reads it |
| `WalletDbEntryI`                           | The rows of `IndexedDBProvider.getWallets()`: `dbUtils.ts`              |

### Wallet state and addresses

| Member                                                                     | Who needs it                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `network`                                                                  | Network checks across the app (`tokenItemFT.vue`, `settingsMenu.vue`, …)                               |
| `networkPrefix`                                                            | Address validation in the send and token forms (`bchWallet.vue`, `identityCard.vue`, …)                |
| `name`                                                                     | `store.ts` sets it after `fromId`; `flipstarterPledge.vue` keys pledges by it                          |
| `provider` (getter)                                                        | `store.ts`, `cashconnectStore.ts`, `identitiesStore.ts` read transactions through it                   |
| `setProvider(provider)`                                                    | `store.ts` `initializeWallet` moves the wallet onto the chosen server                                  |
| `stop()`                                                                   | `walletUtils.ts`, `sweepPrivateKey.vue`, `store.ts` end a wallet's subscriptions                       |
| `getDepositAddress(index?)`, `getTokenDepositAddress(index?)`              | Receive views, `createTokens.vue`, `nftMintForm.vue`, `utxoManagement.vue`, `store.ts`                 |
| `getChangeAddress(index?)`                                                 | `cashconnectStore.ts`                                                                                  |
| `hasAddress(address)`                                                      | `store.ts` `walletHasAddress` and the token watch                                                      |
| `walletCache.get(address)`                                                 | Keys per address for dApp signing: `walletconnectStore.ts`, `cashconnectStore.ts`, `messageSigning.ts` |
| `walletCache.getByIndex(index, branch)`                                    | `store.ts`, `addressRows.ts`                                                                           |
| `walletCache.persist(immediate?)`                                          | **No consumer**: the cache calls it itself                                                             |
| `Wallet`: `cashaddr`, `privateKey`, `publicKeyHash`, `publicKeyCompressed` | `walletconnectStore.ts`, `cashconnectStore.ts`, `messageSigning.ts`, `sweepPrivateKey.vue`             |
| `Wallet`: `tokenaddr`                                                      | Cashonize tests only                                                                                   |
| `Wallet`: `mnemonic`, `derivationPath`, `privateKeyWif`                    | `backupWallet.vue`                                                                                     |
| `HDWallet`: `mnemonic`, `derivation`, `xPub`                               | `backupWallet.vue`, `exportXpub.vue`, `cashconnectStore.ts`, `wizardconnectStore.ts`, `store.ts`       |
| `HDWallet`: `indices`, `rawHistory`                                        | Address rows and Cauldron key scan: `addressRows.ts`, `store.ts`                                       |
| `HDWallet`: `getAddressByBranch`, `getTokenAddressByBranch`                | **No consumer**: Cashonize reads `walletCache.getByIndex`                                              |

### Reading and watching

| Member                                      | Who needs it                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `getUtxos()`                                | The one snapshot everything is computed from: `store.ts` and the tools |
| `getBalance()`                              | `settingsMenu.vue`; counts the sats on token coins too                 |
| `getHistory({ count, concurrency })`        | `store.ts` `updateWalletHistory`                                       |
| `getRawHistory(fromHeight?)`                | **No consumer**: only a Cashonize test mocks it                        |
| `watchBalance(callback)`                    | `store.ts`, balance and CashConnect pushes                             |
| `watchTokenTransactions(callback)`          | `store.ts` token notifications                                         |
| `watchBlocks(callback, skipCurrentHeight?)` | `store.ts` tip and stale-server check                                  |
| `CancelFn`                                  | `store.ts` holds the watches' cancels                                  |

### Spending

| Member or export                                                                  | Who needs it                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `send(requests, options?)`                                                        | Every ordinary send, through `store.spend`                                                                                              |
| `sendMax(cashaddr, options?)`                                                     | `utxoManagement.vue`, `transferAssets.ts`, `store.ts`                                                                                   |
| `getMaxAmountToSend(options?)`                                                    | `store.ts` max button                                                                                                                   |
| `tokenGenesis(genesis, sends?, options?)`                                         | `createTokens.vue` through `store.ts`                                                                                                   |
| `tokenMint(requests, options?)`                                                   | `nftMintForm.vue`, `tokenItemNFT.vue`, `nftChild.vue` through `store.ts`                                                                |
| `tokenBurn(requests, message?, options?)`                                         | `tokenItemFT.vue`, `tokenItemNFT.vue`, `nftChild.vue` through `store.ts`                                                                |
| `submitTransaction(transaction)`                                                  | `walletconnectStore.ts`, `wizardconnectStore.ts` broadcast dApp-built transactions                                                      |
| `SendRequestOptionsI`: `utxoIds`, `excludeUtxoIds`, `ensureUtxos`, `tokenUtxoIds` | The spend's pool (AGENTS.md "Which coins a spend uses"): `store.ts` `spendConfig`, `spendAuthUtxo` (`tokenUtxoIds`), `reservedUtxos.ts` |
| `SendRequestOptionsI`: `broadcast`                                                | `false` builds a signed transaction without broadcasting: Cashonize tests, and the build-then-submit rule                               |
| `SendRequestOptionsI`: `checkTokenQuantities`, `tokenOperation`                   | A hand-built mint through `send`: `nftMintForm.vue` via `store.ts` `spendAuthUtxo`                                                      |
| `SendRequest` (type), `SendRequestType`                                           | The plain `{ cashaddr, value }` request and the request union: `store.ts`                                                               |
| `SendResponse` (type)                                                             | What a spend returns (`txId`, `transaction`, `categories`): every spend site                                                            |
| `TokenSendRequest`                                                                | Token sends: `store.ts`, `authchainIdentity.ts`, token views                                                                            |
| `TokenGenesisRequest`, `TokenMintRequest`, `TokenBurnRequest`                     | `store.ts`, `nftMintForm.vue`                                                                                                           |
| `OpReturnData.fromArray(chunks)`                                                  | BCMR publication outputs: `authchainIdentity.ts`                                                                                        |
| `OpReturnData.parseBinary(script)`                                                | Reading announcements and publications: `txDirection.ts`, `authchainIdentity.ts`                                                        |
| `OpReturnData.fromString(text)`                                                   | Cashonize tests only                                                                                                                    |
| `new OpReturnData(script)`                                                        | A complete OP_RETURN script as given; the factories build through it. No Cashonize use                                                  |

### Errors

Every error the library throws is an exported class (AGENTS.md "Conventions"), so a caller can use `instanceof`.

| Export                                                                                         | Who needs it                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `InsufficientFundsError` (`asset`, `category`; BCH shortfalls also carry an undeclared `data`) | `store.ts` shortfall messages                                                                                      |
| `UtxoNotAvailableError` (`utxoId`, `reason`)                                                   | `store.ts` `spendExplained`, a reserved or moved coin                                                              |
| `InvalidRequestError` (`field`, `value`)                                                       | Cashonize tests; thrown for bad requests and options                                                               |
| `WatchOnlyError`                                                                               | Thrown by every spend of a wallet without its private keys; no Cashonize branch on it yet                          |
| `TokenBurnError` (`category`, `amount`, `nft`)                                                 | Thrown when a built transaction would burn tokens; no Cashonize branch on it yet                                   |
| `InvalidWalletIdError` (`kind`, `reason`)                                                      | Thrown by `fromId`, `named`, `replaceNamed`, `saveNamedWallet`, `deleteNamedWallet`; no Cashonize branch on it yet |
| `InvalidWifError` (`reason`, `network`)                                                        | Thrown by `fromWIF` and `decodeWif`; the sweep keeps its own check for the localized message                       |
| `BroadcastRejectedError` (`reason`, `txid`, `alreadyKnown`)                                    | `broadcastErrors.ts`, `store.ts`, `walletconnectStore.ts`, `wizardconnectStore.ts`, `transferAssets.ts`            |
| `BroadcastTimeoutError` (`txid`, `transaction`)                                                | `broadcastErrors.ts`: a broadcast whose outcome is unknown                                                         |
| `ElectrumTimeoutError`                                                                         | `broadcastErrors.ts`                                                                                               |

### Network

| Export or member                                                                                                                                  | Who needs it                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createProvider(network, servers?, options?)`                                                                                                     | `store.ts` `selectElectrumProvider`                                                                                                                           |
| `ElectrumTransportOptions` (`connectTimeout`, `requestTimeout`)                                                                                   | `store.ts` passes `connectTimeout`                                                                                                                            |
| `createFailoverProvider(network, servers, options?)`, `FailoverTransportOptions` (`gracePeriod`, `staleTipSeconds`, `isOnline`, `onServerChange`) | `store.ts` `providerForSelectedServer`: the server modes and failover                                                                                         |
| `DefaultProvider.servers`                                                                                                                         | `store.ts` sets the servers before the first wallet; planned to give way to `WalletFactoryOptions`                                                            |
| `getNetworkProvider(network?)`                                                                                                                    | The import's derivation-path scan: `walletUtils.ts`                                                                                                           |
| `setGlobalProvider`, `removeGlobalProvider`                                                                                                       | Cashonize tests install a mock provider                                                                                                                       |
| `ElectrumNetworkProvider`                                                                                                                         | The provider type: `store.ts`, the `defi/` lookups, `electrumAuthchain.ts`, `authchainIdentity.ts`                                                            |
| `new ElectrumNetworkProvider(transport, network?)`                                                                                                | Tests over mem-cash (`scripts/check-dist-errors.mjs`); `Transport` itself is not exported                                                                     |
| `network`                                                                                                                                         | `setProvider` refuses another network's provider                                                                                                              |
| `getUtxos(cashaddr)`                                                                                                                              | Contract and authchain lookups: `cauldronPools.ts`, `badgersStake.ts`, `hodlContracts.ts`, `tapswapListings.ts`, `electrumAdapter.ts`, `electrumAuthchain.ts` |
| `getHistory(cashaddr, fromHeight?)`                                                                                                               | `electrumAuthchain.ts`, `walletUtils.ts` scan; `fromHeight` is `@internal`                                                                                    |
| `getRawTransaction(txid)`                                                                                                                         | NFT parsing extensions: `electrumAdapter.ts`, `paryonusd.ts`                                                                                                  |
| `getRawTransactionObject(txid, loadInputValues?)`                                                                                                 | `store.ts` token notifications, `cashconnectStore.ts`                                                                                                         |
| `getRawTransactions(txids, options?)`, `getHeaders(heights, options?)`                                                                            | `electrumAuthchain.ts`; `options.concurrency` bounds the fan-out, `limiter` is `@internal`                                                                    |
| `getBlockHeight()`                                                                                                                                | Confirmations of cached transactions inside the provider; Cashonize tests mock it                                                                             |
| `sendRawTransaction(txHex)`                                                                                                                       | `BaseWallet.submitTransaction` calls it; no Cashonize use                                                                                                     |
| `getRelayFee()`                                                                                                                                   | The wallets' fee rate when `Config.RelayFeePerByte` is unset; no Cashonize use                                                                                |
| `watchAddressStatus(cashaddr, cb)`, `subscribeToAddress(cashaddr, cb)`                                                                            | The wallets' status watches call them; Cashonize tests mock `subscribeToAddress`                                                                              |
| `watchBlocks(cb, skipCurrentHeight?)`                                                                                                             | `wallet.watchBlocks` calls it                                                                                                                                 |
| `subscribeToTransaction(txid, cb)`                                                                                                                | **No consumer**: only `sendRawTransaction` in the same class calls it                                                                                         |
| `connect()`                                                                                                                                       | **No consumer**: every request connects by itself                                                                                                             |
| `disconnect()`                                                                                                                                    | Closing a provider the caller replaced (`setProvider`'s contract); Cashonize does not call it yet                                                             |
| `subscriptions`, `mine(cashaddr, blocks)`                                                                                                         | `@internal`: the library's leak checks and regtest tests                                                                                                      |
| `ElectrumRawTransaction`                                                                                                                          | `interfaces.ts` types outputs with it                                                                                                                         |
| `ElectrumRawTransactionWithInputValues`, `ElectrumRawTransactionVinWithValues`                                                                    | The result of `getRawTransactionObject(txid, true)`: `store.ts`                                                                                               |

### History

| Export                                                             | Who needs it                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `TransactionHistoryItem`, `InOutput`                               | History views and helpers: `txHistory.vue`, `txDirection.ts`, `store.ts`, Cashonize tests |
| `getHistory({ addresses, provider, utxos, count?, concurrency? })` | Cashonize `test/bchWalletLib.test.ts` only; the wallets' `getHistory` runs on it          |

### Messages, rates and conversion

| Export or member                                     | Who needs it                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SignedMessage.sign(message, privateKey)`            | `signVerifyMessage.vue`, `walletconnectStore.ts`                                              |
| `SignedMessage.verify(message, signature, cashaddr)` | `messageSigning.ts`                                                                           |
| `SignedMessageResponseI`, `VerifyMessageResponseI`   | The return types of `sign` and `verify`                                                       |
| `ExchangeRate.getQuote(symbol, { staleOnError })`    | Planned: replaces `ExchangeRate.get(currency, true)` in `store.ts` (consumer notes section 5) |
| `ExchangeRateOptions`, `ExchangeRateQuote`           | The option and return types of `getQuote`                                                     |
| `convert(value, from, to)`                           | Fiat and unit conversion across the app (`bchWallet.vue`, `store.ts`, `utils.ts`, …)          |

### Config

| Member                                    | Who needs it                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `Config.EnforceCashTokenReceiptAddresses` | `store.ts` sets it: token operations require token-aware addresses |
| `Config.DefaultParentDerivationPath`      | `walletUtils.ts` sets it before `named()` creates a wallet         |
| `Config.UseIndexedDBCache`                | `store.ts` turns on the IndexedDB cache                            |
| `Config.RelayFeePerByte`                  | `store.ts` fixes the fee at 1 sat/byte                             |
| `Config.GetExchangeRateFn`                | `settingsStore.ts` picks the rate provider                         |

### Keys, headers, constants and data types

| Export                                                                    | Who needs it                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `getXPubKey(seed, path, network)`, `getAddrsByXpubKey(xpub, path, count)` | The import's derivation-path scan: `walletUtils.ts`                                         |
| `decodeWif(wif)`                                                          | Planned: the sweep's QR filter reads a WIF's network from it                                |
| `decodeHeader(hexHeader)`                                                 | Tip age check: `utils.ts`                                                                   |
| `toHex(bytes)`                                                            | Hex kept in bulk, as flat strings: `transactionIndex.ts`                                    |
| `getTransactionHash(rawTransactionHex)`                                   | **No consumer**: the provider uses it internally; libauth's `hashTransaction` does the same |
| `MAX_OP_RETURN_BYTES`                                                     | BCMR publication size: `authchainIdentity.ts`                                               |
| `GAP_SIZE`, `DEPOSIT_BRANCH`, `CHANGE_BRANCH`                             | HD address rows: `store.ts`, `addressRows.ts`, `hdAddresses.vue`, `hdAddressSelect.vue`     |
| `NetworkType`                                                             | `store.ts`, `walletconnectStore.ts`, `wizardconnectStore.ts`                                |
| `NFTCapability`                                                           | Token forms and identities: `createTokens.vue`, `nftMintForm.vue`, `authchainIdentity.ts`   |
| `Utxo`, `TokenI`, `TxI`, `HexHeaderI`                                     | Types across the app; `Utxo` in most stores, views and tools                                |
| `HeaderI`                                                                 | The return type of `decodeHeader` and `getHeaders`                                          |

## `@cashonize/bch-wallet-lib/indexeddb`

| Export or member                            | Who needs it                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `IndexedDBProvider`                         | `store.ts` sets it as `BaseWallet.StorageProvider`; `dbUtils.ts` reads the databases with it       |
| `new IndexedDBProvider(dbName)`             | `dbUtils.ts` opens `bitcoincash` and `bchtest`                                                     |
| `init()`, `close()`                         | `dbUtils.ts`                                                                                       |
| `getWallets()`, `walletExists(name)`        | `dbUtils.ts` wallet list and existence check                                                       |
| `getWallet(name)`                           | The named-wallet helpers; Cashonize tests                                                          |
| `addWallet`, `updateWallet`, `deleteWallet` | `named`, `replaceNamed`, `saveNamedWallet`, `deleteNamedWallet` call them; no direct Cashonize use |
