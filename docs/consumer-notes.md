# What a real consumer needs: notes from Cashonize

Cashonize (`~/Cashonize/cashonize-wallet`) is this library's first user. It runs on mainnet-js 3.x with a pnpm patch. In many places it reimplements a mainnet-js helper, calls smaller pieces instead of a larger helper, or works around library behavior. This file lists those places, why Cashonize does it, and what that means for the library's API. Cashonize sites are named by file and function; line numbers drift.

The inventory this builds on, written for the fork decision, is `~/Cashonize/mainnet-js-fork/research/cashonize-usage.md` (sections 4 and 7: where the app bypasses mainnet-js and the workarounds it carries). This file adds the reasons and the API conclusions.

Written 2026-10-17 against bch-wallet-lib main `ae646b0`, after the first fix workflow; sections 3 to 5 updated at `2b3fd2e`, after the second, with what the Cashonize migration branch ran into. Sections 3 and 4 say what is fixed and what is still open.

## 1. The pattern: the caller owns the async steps

The reimplementations share a few causes. They make good API rules:

1. **One snapshot, many views.** The app reads the utxo set once and computes everything from it: the balance, token lists, the spendable pool after reservations, address rows. The wallet methods `getBalance`, `getTokenUtxos`, `getAllTokenBalances` and `getAllNftTokenBalances` each call `getUtxos()` again. Cashonize therefore wrote its own pure versions (`utils.ts` `getBalanceFromUtxos`, `getFungibleTokenBalances`, `getAllNftTokenBalances`; `storeUtils.ts` `tokenListFromUtxos`). **Rule:** every derived value is a pure function over a `Utxo[]`, and the wallet methods are thin wrappers over those functions.
2. **The caller sets the concurrency.** The app paces its own requests:
   - authchain walks run at most 10 at once, with spender searches in batches of 50 that stop early (`electrumAuthchain.ts`);
   - Cauldron pool lookups go in batches of 10, and a failed lookup is skipped (`cauldronPools.ts`);
   - the derivation-path scan runs in batches of 10 and stops early (`walletUtils.ts` `scanDerivationPaths`).

   The library does the opposite. `getRawTransactions` and `getHeaders` send every cache miss in one unbounded `Promise.all`, and one failure rejects the whole batch. History backfills balances with one `getBalance` request per address. **Rule:** the library offers single-step primitives, and where it fans out itself, the fan-out is capped and fails per item.

3. **Every step can be checked, cancelled or shown.** The app interleaves its own steps:
   - `transferAssets.ts` re-reads the pool before each of its 2N+1 sends and reports progress between them;
   - the sweep previews the coins before anything is broadcast;
   - history loads 100 entries first and the rest when idle, with a stale-request id and one shared in-flight load (`store.ts` `updateWalletHistory`, `loadFullHistory`);
   - connecting uses a 3 s and then a 12 s window (`utils.ts` `connectElectrum`).

   **Rule:** build without broadcasting (`broadcast: false` plus `submitTransaction` already does this), keep paging, and leave timeouts configurable.

4. **Explicit choices instead of implicit order.** Cashonize relies on things the library happens to do:
   - `tokenGenesis` spends the first vout-0 coin of the pool, so the app puts its chosen coin first;
   - requested outputs come first, so it assumes the new coin is `${txId}:0` (`genesisInputPicker.vue`, `flipstarterPledge.vue`, `store.ts` `spendAuthUtxo`);
   - `tokenMint` takes the first minting NFT of the category.

   **Rule:** let the caller name the coin, and report outpoints in the result.

5. **No side effects from looking.** Some calls that only look still construct things:
   - `namedExists` constructs a wallet, which pins the global provider;
   - a wallet is constructed on the global provider before the app can choose a server;
   - the derivation scan builds about 83 wallets, and on v4 each one subscribes as it is constructed.

   Cashonize works around these with raw IndexedDB (`dbUtils.ts` `namedWalletExistsInDb`), `DefaultProvider.servers` set before the first wallet is constructed, and `Config.DefaultParentDerivationPath` set before `named()`. **Rule:** reads and existence checks construct nothing and subscribe to nothing, and per-call options replace global config.

6. **Errors the app can tell apart.** Cashonize matches error strings to localize messages and to explain reservations (`store.ts` `shortfallMessages`, `broadcastErrors.ts` `classifyBroadcastError`). It also has `typeof error === 'string'` branches, because mainnet-js throws strings. **Rule:** typed `Error` subclasses with fields such as `asset`, `category` and `reason`, and never a thrown string.

7. **State the app can observe, storage it doesn't have to mirror.** The wallet mutates its own internals, so Cashonize keeps it in a `shallowRef` and uses its own `walletUtxos` as the change signal (`store.ts` `walletHasAddress` next to `wallet.hasAddress`). It also opens the library's IndexedDB databases itself and has to match their names, versions and key formats (`cacheUtils.ts`, `dbUtils.ts`); a mistake there fails silently. **Rule:** changes reach the app through watch callbacks or returned snapshots, and every storage operation an app needs (list, delete, prune, clear caches) is library API.

## 2. Helpers a real consumer doesn't use as they are

| Helper                                                                            | What Cashonize does instead                                                                                                                         | Verdict                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `getBalance`, `getTokenUtxos`, `getAllTokenBalances`, `getAllNftTokenBalances`    | Pure functions over one snapshot                                                                                                                    | Keep the methods as wrappers; export the pure functions                                                                            |
| `getBalance` (it counts the sats on token utxos too)                              | Recomputes the BCH-only balance after every `watchBalance`                                                                                          | Add a `bchOnly` option or a `watchUtxos(cb)`                                                                                       |
| `named()` (it creates a missing wallet)                                           | `loadWalletFromId` / `walletTypeFromWalletId`                                                                                                       | Add a load-only `loadNamed`, or a typed `walletFromId` that checks the network                                                     |
| `namedExists`                                                                     | Raw IndexedDB check                                                                                                                                 | Make it a free function that constructs nothing                                                                                    |
| `watchTransactions` / `watchTokenTransactions`                                    | Fetches each tx again for its input values to skip self-sent ones                                                                                   | Add a `loadInputValues` option; a utxo-set diff could avoid the network entirely                                                   |
| `signUnsignedTransaction` (it overwrites every input with one key's P2PKH unlock) | WalletConnect, WizardConnect and flipstarter each sign with libauth: per-input keys, contract placeholders, ALL\|UTXOS or ALL\|ANYONECANPAY sighash | Add a single-input signer (`signInput(tx, sourceOutputs, i, key, {hashType, algorithm})`); sign only the wallet's own empty inputs |
| `tokenMint` for an identity's minting NFT                                         | Hand-built mint via `send` with `ensureUtxos: [authUtxo]` (`authchainIdentity.ts` `mintOutputs`)                                                    | Let the caller name the minting utxo and its return address                                                                        |
| `toCurrency` / `toBch` (async, they fetch a rate)                                 | Sync multiply with a rate already held (`utils.ts` `convertToCurrency`, `satsToBch`)                                                                | Removed in round 3                                                                                                                 |
| `getMaxAmountToSend`, then `send`                                                 | Same, after a confirm dialog                                                                                                                        | Fine; `sendMax` when the amount equals the max                                                                                     |
| Transfer everything                                                               | 2N+1 sends (`transferAssets.ts`)                                                                                                                    | Optional `sendAll(addr, {utxoIds})`: one transaction, no change                                                                    |

Used as intended and fine: `sendMax` over a one-coin pool, `OpReturnData.fromArray`, `decodeHeader`, `convert`, `watchBlocks`, `getHeaders`, `submitTransaction`, `ExchangeRate.get` with `Config.GetExchangeRateFn`, and the storage provider's `getWallets`.

## 3. Open library work, by priority

Done in round 2 and moved to section 4: reserved coins out of every spend (`excludeUtxoIds`, `ensureUtxos` inside the pool), the exchange-rate fallback, request validation, cheaper history.

1. **Choose the server at construction.** Add `fromId(id, {provider})` / `named(name, {provider})`. Today HD discovery starts on the global provider, and Cashonize sets `DefaultProvider.servers` in advance so the wallet's addresses don't leak to a default server. On the migration branch, the sweep's temporary wallets and every wallet before `initializeWallet` still use the global provider. `setProvider` already exists; it leaves the old provider connected, which Cashonize can disconnect itself once `setProvider` resolves (say so in its JSDoc).
2. **Saving constructs nothing.** `replaceNamed` (and `named` when it creates) constructs the wallet, and construction subscribes: the chipnet copy Cashonize stores of every new wallet subscribes on chipnet, and an import's two copies do the same. Add a store-only `saveNamedWallet(name, walletId, dbName)`. Same rule for `namedExists`, which still constructs a wallet.
3. Done on the app side, moved to section 4 (an address scan that constructs no wallets).
4. **Explicit coins in token operations.**
   - A `genesisInputs` option on `tokenGenesis` that throws if the coin isn't available (today: narrow with `utxoIds` and rely on order).
   - The minting utxo and its return address as options on `tokenMint`.
   - The outpoint of each requested output in `SendResponse`.
5. **Public HD address info.** Add `addressInfo(branch, index)` returning `{address, tokenAddress, publicKeyHash, used, txCount, utxos}`, and make `getUsedAddresses(branch)` public. Also derive addresses on untracked branches, such as the defi chain 7, without counting them in the balance. Cashonize reads `walletCache` and the raw history maps directly (`addressRows.ts`, `hdAddresses.vue`, `hdAddressSelect.vue`, `wizSigning.ts`, `cauldronPools.ts`).
6. **Errors that are still plain `Error`s or not `Error`s.**
   - `checkUtxos` throws a plain `Error` ("Utxos [...] not found in wallet") for a `utxoIds` coin no longer in the wallet, the case of a coin spent between a read and the send; the same case in `ensureUtxos` throws `UtxoNotAvailableError`. Use that.
   - `IndexedDbCache` rejects with the raw `Event` (`request.onerror = reject` in getItem, setItem, removeItem); use `requestError(request)` as `IndexedDBProvider` does.
   - Wallet id parsing, the relay-fee settings and `decodeWif` throw plain `Error`s. Give WIF errors a type or code and export `decodeWif` or `wifNetwork`; the sweep QR filter guesses the network from the first character.
7. **Storage helpers that don't stop at one bad row.** `pruneWalletCaches` throws "Not a stored wallet id" on one unreadable stored id, which blocks every later prune; skip such ids (Cashonize's old prune did). `getNamedWalletId` returns `''` for an empty stored id; return `undefined`.
8. **Coin-control hooks and burn allowances (round-2 final review, medium).** `outputOrdering` is not held to a permutation of the outputs, so a hook can drop the change or change a value; check it as `inputOrdering` is. `tokenBurns` is on the public send options and its allowance in `tokenBurn` is too wide (an NFT kept but listed as burnable, NFTs not counted). Cashonize uses neither hook.
9. **History.** Let `getRawTransactions` and `getHeaders` fail per item; one failure still rejects the whole call. An HD wallet's address discovery still subscribes, and fetches for, every address of a gap extension at once.
10. **Smaller additions.**
    - Export `utxoToSourceOutput(utxo)`, which the library's own `prepareInputs` and `prepareTokenOutputs` also use. Cashonize has three copies (`utxoConverter.ts`, `flipstarter.ts`, `cashconnectStore.ts`), and `prepareInputs` quietly uses a zero key when the cache has none.
    - Add `provider.getSourceOutput(txid, vout)` with exact bigints.
    - Add a wallet-level `signMessage(message, address?)`.
    - Accept the token form of an address in `hasAddress`, or add `hasLockingBytecode`.
    - Add a derivation option on `named` / `newRandom`.
    - Add `skipInitial` on `watchBalance` / `watchStatus`, as `watchBlocks` already has.
    - Check the 100 kB standard size before signing.

## 4. Already fixed here: Cashonize code that goes on migration

| Cashonize workaround                                                                                                | Fixed by                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm patch: `utxoIds` in `tokenMint` and `tokenBurn`, history outpoints, P2S history outputs, 128-byte commitments  | mainnet-js#250, #248/#252, #244                                                                                                                                                         |
| `retryInitializationAfterOffline` rebuilds the wallet (it only needs to call `initializeWallet()` again)            | HD discovery and a single-address wallet's status watch settle, reject and retry (mainnet-js#256)                                                                                       |
| `seenTokenTxIds`, pre-filled from history                                                                           | No replay in transaction watches (mainnet-js#257)                                                                                                                                       |
| `runAsyncVoid` around the async `watchBalance` and `watchTokenTransactions` callbacks                               | Async watch callbacks are handled; their errors go to `onError` or `console.error`                                                                                                      |
| `reserveAddOutputs` builds its own token change; `spendAuthUtxo` narrows the pool (it may stay as defense in depth) | Change taken from the spent inputs; FT sends spend only what they need (mainnet-js#247, #246)                                                                                           |
| `opReturnChunks`; parsing the `OP_RETURN:`/`SCRIPT:` placeholder; the 220-byte budget                               | `parseBinary` rewrite, `lockingBytecode` on history, `MAX_OP_RETURN_BYTES` (mainnet-js#260, #248). `parseBinary` now throws on malformed scripts, so wrap it when reading on-chain data |
| `shortfallMessages`; the 550-sat pre-checks                                                                         | `InsufficientFundsError`                                                                                                                                                                |
| `electrumTimeoutMessage` string compare                                                                             | `ElectrumTimeoutError`                                                                                                                                                                  |
| `classifyBroadcastError` message matching; `typeof error === 'string'` branches                                     | `BroadcastRejectedError` with `reason` and `alreadyKnown`; only `Error`s are thrown                                                                                                     |
| `BCH_RELAY_FEE` globals                                                                                             | `Config.RelayFeePerByte` and the checked server fee (mainnet-js#254)                                                                                                                    |
| `getNamedWalletIdFromDb`, `deleteWalletFromDb`, `pruneHdWalletKeyCache`                                             | `getNamedWalletId` returns `undefined`; `deleteNamedWallet`, `pruneWalletCaches` (mainnet-js#261, #249)                                                                                 |
| `cashconnectStore.waitForBlockchainConnection`; `connectElectrum` windows                                           | Each request connects; silent sockets are replaced; set `connectTimeout: 15000`                                                                                                         |
| The uncompressed-WIF pre-check (keep it only for the localized message)                                             | Error-free `decodeWif` (mainnet-js#258)                                                                                                                                                 |
| `spendConfig` pre-reads `getUtxos()` and subtracts the reservations into `utxoIds`                                  | `excludeUtxoIds` on every spend; an `ensureUtxos` coin outside the pool throws `UtxoNotAvailableError`                                                                                  |
| The exchange-rate fallback to the last known rate (`currentExchangeRate`)                                           | `ExchangeRate.getQuote(symbol, {staleOnError})` with `stale` and `fetchedAt`; the cache follows `GetExchangeRateFn`                                                                     |
| `nftMintForm.vue` `isHex`; genesis amount range checks                                                              | `InvalidRequestError` for bad hex, odd length, >128-byte commitments and amounts outside 0..2^63−1                                                                                      |
| Lowercasing and try/catch around `SignedMessage.verify`; libauth `decodeTransaction` instead of the library's       | `verify` compares decoded addresses and returns `valid: false`; `decodeTransaction` decodes every output and takes a provider                                                           |
| `spendAuthUtxo`'s narrowing as the only guard against a burn                                                        | `TokenBurnError` refuses a built transaction that burns tokens (the narrowing stays as defense in depth)                                                                                |
| `scanDerivationPaths` building ~83 wallets that each subscribe and are never stopped                                | The scan derives each path's addresses with `getXPubKey` and `getAddrsByXpubKey` and asks `getNetworkProvider(…).getHistory` directly, building no wallet (Cashonize `e747c92`)         |
| Comments about `UseLocalStorageCache` and `DefaultCurrency` being unsafe                                            | `UseLocalStorageCache` is removed; the rate fix (#262)                                                                                                                                  |

## 5. API breaks Cashonize will hit

- `wallet.provider = …` throws, because `provider` is now a getter; use `setProvider`. `Connection` no longer exists; use `createProvider`.
- `wallet.sign()` and `wallet.verify()` no longer exist; use `SignedMessage.sign` / `verify`. `verify` takes the address as a required argument, and the responses carry only `signature` and `valid`.
- `Network` is no longer exported: `Network.MAINNET` becomes `NetworkType.Mainnet` (`walletUtils.ts` and its mock).
- `tokenMint(mintRequests, deductTokenAmount, options)`: the category now goes inside each request.
- The HD fields `depositIndex`, `changeIndex`, `depositRawHistory` and `changeRawHistory` are replaced by per-branch `indices` / `rawHistory` maps. `walletCache.getByIndex(i, change)` became `getByIndex(i, branch)`.
- Single-address wallets now subscribe on construction (their cache stays in memory, as in 3.1.7). Never construct one just to look something up.
- `watchBalance` still fires once on subscribe, so Cashonize's `electrumSubscriptionsActive` guard stays.
- A `TokenSendRequest` with amount 0 and no NFT now throws `InvalidRequestError`. `createTokens.vue` builds one when the circulating amount is 0; skip that output instead.
- Coins picked for mutable-NFT requests now come after the other token coins in the inputs.
- mainnet-js 3.1.7 can't open an `hd:<xprv>` row, so a wallet stored that way can't be rolled back. Check whether Cashonize ever stores one.
