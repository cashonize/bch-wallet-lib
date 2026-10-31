# Public API and why each part exists

Every name the package exports, every public class member and every option group, with who needs it. Checked against Cashonize `main` (`d749f7d3`, on library 0.2.2) for the 0.3.0 surface. Cashonize sites are file names; `docs/consumer-notes.md` says why Cashonize uses them.

A new export needs a row here and a real consumer. Rows marked **no consumer** have no Cashonize use: they are candidates for removal unless the row gives a reason to keep them public. Members tagged `@internal` in the source are left out of the published types (`stripInternal`); they are listed under each section's "Internal" line, not in the tables.

Entry points (`package.json` `exports`): `@cashonize/bch-wallet-lib` and `@cashonize/bch-wallet-lib/indexeddb`.

## `@cashonize/bch-wallet-lib`

### Wallet classes and factories

| Export or member                                   | Who needs it                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Wallet`                                           | Single-address wallets: `interfaces.ts` (`WalletType`), `walletUtils.ts`, `utils.ts`, `sweepPrivateKey.vue`                         |
| `HDWallet`                                         | HD wallets: `interfaces.ts`, `walletUtils.ts`, `store.ts`, `addressRows.ts`; `instanceof HDWallet` tells the kind                   |
| `BaseWallet`                                       | `store.ts` sets `BaseWallet.StorageProvider`; Cashonize tests type wallets with it                                                  |
| `static fromId(walletId, options?)` (both classes) | Loads a stored id: `utils.ts` `loadWalletFromId`                                                                                    |
| `Wallet.fromWIF(wif, options?)`                    | The sweep's temporary wallet: `sweepPrivateKey.vue`                                                                                 |
| `static newRandom(name?, options?)` (both classes) | **No consumer**: Cashonize creates wallets with `named`; the only way to make a random wallet that is not stored                    |
| `static named(name, options?)`                     | Creates the wallet of a new name: `walletUtils.ts` create flows                                                                     |
| `WalletFactoryOptions` (`network`)                 | Test-network wallets, the only way to make one (chipnet is `"testnet"`): `utils.ts`, `walletUtils.ts`, `sweepPrivateKey.vue`        |
| `WalletFactoryOptions` (`provider`)                | **No consumer**: the wallet starts on that provider and no global one is made; Cashonize uses `setGlobalProvider` and `setProvider` |
| `toDbString()`                                     | **No consumer** in Cashonize's source; the id `saveNamedWallet` stores and the library writes its rows with                         |

### Named wallet storage

| Export or member                           | Who needs it                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getNamedWalletId(name, dbName?)`          | `store.ts` `loadExistingWallet`, loading without `named`'s create; `tiedWallets.ts`                                                                        |
| `namedWalletExists(name, dbName?)`         | `WalletPage.vue`, `walletUtils.ts`                                                                                                                         |
| `saveNamedWallet(name, walletId, dbName?)` | The import flows: `walletUtils.ts`; refuses a mnemonic id without its derivation path                                                                      |
| `deleteNamedWallet(name, dbName?)`         | `store.ts` wallet deletion, both databases; `tiedWallets.ts`                                                                                               |
| `pruneWalletCaches(keepWalletIds)`         | `dbUtils.ts` start-up prune of cache records with no row                                                                                                   |
| `BaseWallet.StorageProvider` (static)      | `store.ts` sets `IndexedDBProvider`; every named-wallet helper reads it                                                                                    |
| `StorageProvider` (type)                   | **No consumer**: what `BaseWallet.StorageProvider` takes, for a storage other than `IndexedDBProvider` (an encrypted one, section 6 of the consumer notes) |
| `WalletDbEntryI`                           | The rows of `IndexedDBProvider.getWallets()`: `dbUtils.ts`                                                                                                 |

### Wallet state and addresses

| Member                                                                     | Who needs it                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `network`                                                                  | Network checks across the app (`tokenItemFT.vue`, `settingsMenu.vue`, …)                               |
| `networkPrefix`                                                            | Address validation in the send and token forms (`bchWallet.vue`, `identityCard.vue`, …)                |
| `name`                                                                     | `store.ts` sets it after `fromId`; `flipstarterPledge.vue` keys pledges by it                          |
| `provider` (getter)                                                        | `store.ts`, `cashconnectStore.ts`, `identitiesStore.ts` read transactions through it                   |
| `setProvider(provider)`                                                    | `store.ts` `initializeWallet` moves the wallet onto the chosen server                                  |
| `stop()`                                                                   | `walletUtils.ts`, `sweepPrivateKey.vue`, `store.ts` end a wallet's subscriptions                       |
| `getDepositAddress(index?)`, `getTokenDepositAddress(index?)`              | `store.ts`, `walletconnectStore.ts`, `signVerifyMessage.vue`                                           |
| `getChangeAddress(index?)`                                                 | `cashconnectStore.ts`                                                                                  |
| `hasAddress(address)`                                                      | `store.ts` `walletHasAddress` and the token watch                                                      |
| `walletCache.get(address)`                                                 | Keys per address for dApp signing: `walletconnectStore.ts`, `cashconnectStore.ts`, `messageSigning.ts` |
| `walletCache.getByIndex(index, branch)`                                    | `store.ts`, `addressRows.ts`                                                                           |
| `walletCache.persist(immediate?)`                                          | Cashonize tests force the cache write with it (`dbUtils.indexeddb.test.ts`); the cache calls it itself |
| `Wallet`: `cashaddr`, `privateKey`, `publicKeyHash`, `publicKeyCompressed` | `walletconnectStore.ts`, `cashconnectStore.ts`, `messageSigning.ts`, `sweepPrivateKey.vue`             |
| `Wallet`: `mnemonic`, `derivationPath`, `privateKeyWif`                    | `backupWallet.vue`                                                                                     |
| `HDWallet`: `mnemonic`, `derivation`, `xPub`                               | `backupWallet.vue`, `exportXpub.vue`, `cashconnectStore.ts`, `wizardconnectStore.ts`, `store.ts`       |
| `HDWallet`: `indices`, `rawHistory`                                        | Address rows and Cauldron key scan: `addressRows.ts`, `store.ts`                                       |

Internal: `Wallet.tokenaddr` (`getTokenDepositAddress()` returns it), `HDWallet.getAddressByBranch` and `getTokenAddressByBranch`, and the wallet cache's `init`, `flush`, `getByPath` and `setStatusAndUtxos`.

### Reading and watching

| Member                                      | Who needs it                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `getUtxos()`                                | The one snapshot everything is computed from: `store.ts` and the tools                                      |
| `getBalance()`                              | **No consumer**: Cashonize sums its utxos                                                                   |
| `getHistory({ count, concurrency })`        | `store.ts` `updateWalletHistory`, `identitiesStore.ts`                                                      |
| `getRawHistory(fromHeight?)`                | The txids of the history: `store.ts`, `transactionIndex.ts`                                                 |
| `watchUtxos(callback)`                      | Planned: replaces `store.ts`'s `watchBalance` and `watchTokenTransactions` and the CashConnect balance push |
| `watchBlocks(callback, skipCurrentHeight?)` | `store.ts` tip and stale-server check                                                                       |
| `CancelFn`                                  | `store.ts` holds the watches' cancels                                                                       |

### Spending

| Member or export                                                                  | Who needs it                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `send(requests, options?)`                                                        | Every ordinary send, through `store.spend`                                                                                              |
| `sendMax(cashaddr, options?)`                                                     | `utxoManagement.vue`, `transferAssets.ts`, `store.ts`                                                                                   |
| `getMaxAmountToSend(options?)`                                                    | `store.ts` max button                                                                                                                   |
| `tokenGenesis(genesis, sends?, options?)`                                         | `createTokens.vue` through `store.ts`                                                                                                   |
| `tokenMint(requests, options?)`                                                   | `nftMintForm.vue`, `tokenItemNFT.vue`, `nftChild.vue` through `store.ts`                                                                |
| `tokenBurn(requests, message?, options?)`                                         | `tokenItemFT.vue`, `tokenItemNFT.vue`, `nftChild.vue` through `store.ts`                                                                |
| `submitTransaction(transaction)`                                                  | `walletconnectStore.ts`, `wizardconnectStore.ts` broadcast dApp-built transactions; `store.ts` broadcasts one again                     |
| `SendRequestOptionsI`: `utxoIds`, `excludeUtxoIds`, `ensureUtxos`, `tokenUtxoIds` | The spend's pool (AGENTS.md "Which coins a spend uses"): `store.ts` `spendConfig`, `spendAuthUtxo` (`tokenUtxoIds`), `reservedUtxos.ts` |
| `SendRequestOptionsI`: `excludeAddresses`                                         | Frozen addresses: `store.ts`, `transferAssets.ts`                                                                                       |
| `SendRequestOptionsI`: `broadcast`                                                | `false` builds a signed transaction without broadcasting: Cashonize tests, and the build-then-submit rule                               |
| `SendRequestOptionsI`: `tokenOperation`                                           | A hand-built mint through `send`: `nftMintForm.vue` via `store.ts` `spendAuthUtxo`                                                      |
| `SendRequestOptionsI`: `sweepTokenSatoshis`                                       | **No consumer**: a max send that also takes the sats on token coins                                                                     |
| `SendRequest` (type), `SendRequestType`                                           | The plain `{ cashaddr, value }` request and the request union: `store.ts`                                                               |
| `SendResponse` (type)                                                             | What a spend returns (`txId`, `transaction`, `categories`): every spend site                                                            |
| `TokenSendRequest`                                                                | Token sends: `store.ts`, `authchainIdentity.ts`, token views                                                                            |
| `TokenGenesisRequest`, `TokenMintRequest`, `TokenBurnRequest`                     | `store.ts`, `nftMintForm.vue`                                                                                                           |
| `OpReturnData.fromArray(chunks)`                                                  | BCMR publication outputs: `authchainIdentity.ts`                                                                                        |
| `OpReturnData.parseBinary(script)`                                                | Reading announcements and publications: `txDirection.ts`, `authchainIdentity.ts`                                                        |
| `OpReturnData.fromString(text)`                                                   | Cashonize tests only                                                                                                                    |
| `new OpReturnData(script)`, `.buffer`                                             | A complete OP_RETURN script as given; the factories build through it. Cashonize tests read `buffer`                                     |

Internal: the `checkTokenQuantities` send option, which `tokenGenesis`, `tokenMint` and `tokenBurn` set.

### Errors

Every error the library throws is an exported class (AGENTS.md "Conventions"), so a caller can use `instanceof`.

| Export                                                                  | Who needs it                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `InsufficientFundsError` (`asset`, `category`, `required`, `available`) | `store.ts` `spendExplained`                                                                                              |
| `UtxoNotAvailableError` (`utxoId`, `reason`)                            | `store.ts` `spendExplained`, a reserved or moved coin                                                                    |
| `InvalidRequestError` (`field`, `value`)                                | Cashonize tests; thrown for bad requests and options                                                                     |
| `WatchOnlyError`                                                        | Thrown by every spend of a wallet without its private keys; no Cashonize branch on it yet                                |
| `TokenBurnError` (`category`, `amount`, `nft`)                          | Thrown when a built transaction would burn tokens; no Cashonize branch on it yet                                         |
| `InvalidWalletIdError` (`kind`, `reason`)                               | Thrown by `fromId`, `named`, `saveNamedWallet`, `deleteNamedWallet`; no Cashonize branch on it yet                       |
| `InvalidWifError` (`reason`, `network`)                                 | Thrown by `fromWIF` and `decodeWif`; the sweep keeps its own check for the localized message                             |
| `BroadcastRejectedError` (`reason`, `txid`, `alreadyKnown`)             | `broadcastErrors.ts`                                                                                                     |
| `BroadcastTimeoutError` (`txid`, `transaction`)                         | A broadcast whose outcome is unknown: `broadcastErrors.ts`, `store.ts`, `walletconnectStore.ts`, `wizardconnectStore.ts` |
| `ElectrumTimeoutError`                                                  | A connect or request without an answer; Cashonize tests only                                                             |

### Network

| Export or member                                                       | Who needs it                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createProvider(network, servers?, options?)`                          | `store.ts` `validateElectrumServer`                                                                                                                                             |
| `ElectrumTransportOptions` (`connectTimeout`, `requestTimeout`)        | `store.ts` passes `connectTimeout`, through `FailoverTransportOptions` to `createFailoverProvider`                                                                              |
| `createFailoverProvider(network, servers, options?)`                   | `store.ts`: the server modes; `FailoverTransportOptions` adds `gracePeriod`, `staleTipSeconds`, `isOnline`, `onServerChange`, `onConnectionChange`                              |
| `registerNetwork(config)`, `NetworkConfig`, `ChainCheck`               | `networks.ts` registers testnet4                                                                                                                                                |
| `networkConfig(name)`, `knownNetworks()`                               | Database names and key versions per network: `networks.ts`, `walletUtils.ts`, `wizardconnectStore.ts`                                                                           |
| `ElectrumConnectError` (`failures`)                                    | Thrown when no server could be reached; no Cashonize use                                                                                                                        |
| `DefaultProvider.servers`                                              | `store.ts` keeps the fallback global provider off the built-in servers                                                                                                          |
| `getNetworkProvider(network?)`                                         | The import's derivation-path scan and the tied-wallet scan: `walletUtils.ts`, `tiedWallets.ts`                                                                                  |
| `setGlobalProvider`                                                    | `store.ts` installs the chosen provider as the network's global one; Cashonize tests install a mock                                                                             |
| `removeGlobalProvider`                                                 | Cashonize tests reset the global provider                                                                                                                                       |
| `ElectrumNetworkProvider`                                              | The provider type: `store.ts`, the `defi/` lookups, `electrumAuthchain.ts`, `authchainIdentity.ts`                                                                              |
| `new ElectrumNetworkProvider(transport, network?)`                     | Tests over mem-cash (`scripts/check-dist-errors.mjs`); `Transport` itself is not exported                                                                                       |
| `network`                                                              | `setProvider` refuses another network's provider                                                                                                                                |
| `getUtxos(cashaddr)`                                                   | Contract and authchain lookups: `cauldronPools.ts`, `badgersStake.ts`, `hodlContracts.ts`, `tapswapListings.ts`, `electrumAdapter.ts`, `electrumAuthchain.ts`; `tiedWallets.ts` |
| `getHistory(cashaddr, fromHeight?)`                                    | `electrumAuthchain.ts`, `walletUtils.ts` and `tiedWallets.ts` scans; `fromHeight` is for the wallets' incremental refresh                                                       |
| `getRawTransaction(txid)`                                              | NFT parsing extensions: `electrumAdapter.ts`, `paryonusd.ts`; `cashconnectStore.ts`                                                                                             |
| `getRawTransactions(txids, options?)`, `getHeaders(heights, options?)` | `electrumAuthchain.ts`, `transactionIndex.ts`; `options.concurrency` bounds the fan-out                                                                                         |
| `getBlockHeight()`                                                     | **No consumer**: one `blockchain.headers.get_tip` request; Cashonize follows the tip with `watchBlocks`                                                                         |
| `sendRawTransaction(txHex)`                                            | **No consumer**: `BaseWallet.submitTransaction` calls it; a broadcast without a wallet                                                                                          |
| `watchAddressStatus(cashaddr, cb)`                                     | **No consumer**: the wallets' status watches call it; watching an address no wallet holds                                                                                       |
| `watchBlocks(cb, skipCurrentHeight?)`                                  | `wallet.watchBlocks` calls it                                                                                                                                                   |
| `disconnect()`                                                         | Closing a provider the caller replaced (`setProvider`'s contract): `store.ts`                                                                                                   |

Internal: the provider's `connect`, `getRelayFee` (read through the relay fee cache), `subscribeToAddress`, `subscribeToTransaction` and `subscriptions`, and `ConcurrencyOptions.limiter`. The regtest `mine` is a test helper (`test/mine.ts`), not a provider member.

### History

| Export                               | Who needs it                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `TransactionHistoryItem`, `InOutput` | History views and helpers: `txHistory.vue`, `txDirection.ts`, `transactionIndex.ts`, `store.ts`, Cashonize tests |

The free `getHistory` the wallets' `getHistory` runs on is no longer exported.

### Messages, rates and conversion

| Export or member                                     | Who needs it                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SignedMessage.sign(message, privateKey)`            | `signVerifyMessage.vue`, `walletconnectStore.ts`                                     |
| `SignedMessage.verify(message, signature, cashaddr)` | `messageSigning.ts`                                                                  |
| `SignedMessageResponseI`, `VerifyMessageResponseI`   | The return types of `sign` and `verify`                                              |
| `ExchangeRate.getQuote(symbol, { staleOnError })`    | `store.ts`, the rate with its stale fallback                                         |
| `ExchangeRateOptions`, `ExchangeRateQuote`           | The option and return types of `getQuote`                                            |
| `convert(value, from, to)`                           | Fiat and unit conversion across the app (`bchWallet.vue`, `store.ts`, `utils.ts`, …) |

### Config

| Member                                    | Who needs it                                                       |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `Config.EnforceCashTokenReceiptAddresses` | `store.ts` sets it: token operations require token-aware addresses |
| `Config.DefaultParentDerivationPath`      | `walletUtils.ts` sets it before `named()` creates a wallet         |
| `Config.UseIndexedDBCache`                | `store.ts` turns on the IndexedDB cache                            |
| `Config.RelayFeePerByte`                  | `store.ts` fixes the fee at 1 sat/byte                             |
| `Config.GetExchangeRateFn`                | `settingsStore.ts` picks the rate provider                         |

### Keys, headers, constants and data types

| Export                                                                    | Who needs it                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `getXPubKey(seed, path, network)`, `getAddrsByXpubKey(xpub, path, count)` | The import's derivation-path scan: `walletUtils.ts`                                       |
| `decodeWif(wif)`                                                          | The sweep's WIF network check: `sweepPrivateKey.vue`                                      |
| `decodeHeader(hexHeader)`                                                 | Tip age check: `utils.ts`                                                                 |
| `toHex(bytes)`                                                            | Hex kept in bulk, as flat strings: `transactionIndex.ts`                                  |
| `MAX_OP_RETURN_BYTES`                                                     | BCMR publication size: `authchainIdentity.ts`                                             |
| `GAP_SIZE`, `DEPOSIT_BRANCH`, `CHANGE_BRANCH`                             | HD address rows: `store.ts`, `addressRows.ts`, `hdAddresses.vue`, `hdAddressSelect.vue`   |
| `NetworkType`                                                             | `sweepPrivateKey.vue`, `tiedWallets.ts`                                                   |
| `NFTCapability`                                                           | Token forms and identities: `createTokens.vue`, `nftMintForm.vue`, `authchainIdentity.ts` |
| `Utxo`, `TokenI`, `TxI`, `HexHeaderI`                                     | Types across the app; `Utxo` in most stores, views and tools                              |
| `HeaderI`                                                                 | The return type of `decodeHeader` and `getHeaders`                                        |

`getTransactionHash` is no longer exported; libauth's `hashTransaction` gives the same txid.

## `@cashonize/bch-wallet-lib/indexeddb`

| Export or member                            | Who needs it                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `IndexedDBProvider`                         | `store.ts` sets it as `BaseWallet.StorageProvider`; `dbUtils.ts` reads the databases with it |
| `new IndexedDBProvider(dbName)`             | `dbUtils.ts` opens `bitcoincash` and `bchtest`                                               |
| `init()`, `close()`                         | `dbUtils.ts`                                                                                 |
| `getWallets()`                              | `dbUtils.ts` wallet list                                                                     |
| `getWallet(name)`, `walletExists(name)`     | The named-wallet helpers; Cashonize tests read `getWallet`                                   |
| `addWallet`, `updateWallet`, `deleteWallet` | `named`, `saveNamedWallet`, `deleteNamedWallet` call them; Cashonize tests call `addWallet`  |
