# Storage written by mainnet-js 3.1.7

Cashonize users' browsers hold what mainnet-js 3.1.7 wrote (AGENTS.md, "Persistent storage is frozen"). `v3.1.7.json` is that data, and `src/storage-3.1.7.test.ts` loads it into fake-indexeddb and checks that the library reads it unchanged.

Regenerate it (needs Cashonize's `node_modules`, with mainnet-js 3.1.7 and `@mainnet-cash/indexeddb-storage` 3.1.7; set `CASHONIZE_MODULES` if they live elsewhere than `~/Cashonize/cashonize-wallet/node_modules`):

```bash
node test/fixtures/storage-3.1.7/generate.mjs && pnpm format
```

The output is deterministic, so a regenerated fixture that differs means 3.1.7's behavior (or the generator) changed.

## What it holds

`generate.mjs` runs 3.1.7 under Node with fake-indexeddb and node-localstorage, configured as Cashonize configures it (`Config.UseIndexedDBCache`, `IndexedDBProvider`, `DefaultParentDerivationPath = m/44'/145'/0'`), against a fake electrum server (`shared.mjs`) that gives the wallets history, utxos and a token coin. It stores the wallets of `walletSpecs` in both the `bitcoincash` and `bchtest` databases, opens each by name on its network, lets HD discovery and the cache writes finish, and dumps:

- `indexedDB`: every database with its version, stores (key path, auto increment) and records: the wallet databases (version 31), `WalletCache` and `ElectrumNetworkProviderCache` (version 1);
- `localStorage`: the `rate-usd` exchange rate cache;
- `expected`: what 3.1.7 derived for each wallet (type, ids, addresses and keys of the first deposit and change indices, discovery indices, balance, utxos);
- `chain`: the fake server's data, which the test serves again, and `electrumCache`: which transactions and headers were cached.

The wallets: single-address seed wallets on the standard and the bitcoin.com path (what Cashonize's create and import flows store), a WIF, a private key and a watch-only address wallet, HD wallets from a mnemonic on the standard path (12 and 24 words) and on mainnet-js's default path `m/44'/0'/0'` (with discovery past the first gap), and a watch-only HD wallet from an account xpub. Keys are BIP39 test vectors and the private keys 1 to 3, never real ones.

## Left out

- The network: the fake server answers what discovery and the cache writes ask, nothing is broadcast, and decoded history (`getHistory`) is not run. The electrum caches are filled by calling the provider's `getRawTransaction(s)` and `getHeader(s)` directly.
- Wallets made by `named()` from a random mnemonic: their ids are built in the form `named()` stores (`seed:<network>:<mnemonic>:m/44'/145'/0'/0/0`, `hd:<network>:<mnemonic>:m/44'/145'/0':0:0`) and stored with `replaceNamed`, as Cashonize's import flows do.
- The exchange rate goes through `ExchangeRate.getRateFromLocalStorage` directly with a stubbed `Config.GetExchangeRateFn`, since in Node 3.1.7 only caches it in the global scope.
- `Config.UseLocalStorageCache` and `UseMemoryCache` (Cashonize uses neither), the encrypted storage provider, the regtest database, and the app's own localStorage keys and WalletConnect / CashConnect databases, which are not the library's.

What 3.1.7 does not write is visible in the dump: single-address wallets have no `WalletCache` record (their cache is an in-memory `Map`), and neither has the xpub HD wallet, whose debounced write throws on its missing private keys.
