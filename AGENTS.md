# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

bch-wallet-lib is a Bitcoin Cash wallet library, continued from mainnet-js `4.0.0-next.14`. Its first user is the Cashonize wallet (`~/Cashonize/cashonize-wallet`), which runs it in browsers, Electron and Capacitor. Key material, signing and coin selection live here, so this is security-critical code: being overly careful is preferred over under-careful.

`docs/consumer-notes.md` lists where Cashonize reimplements or works around library helpers, and the API rules that follow from it (pure functions over one utxo snapshot, caller-controlled concurrency, explicit coin choices, no side effects from reads, typed errors). Read it before adding or changing public API.

## Commands

```bash
pnpm test           # vitest on the in-memory chain (mem-cash); the default, no Docker
pnpm test:regtest   # the same suite against BCHN + Fulcrum in Docker
pnpm test:regtest:local  # the same on local BCHN + Fulcrum binaries, no Docker (README: Regtest without Docker)
pnpm test:browser   # browser tests (vitest browser mode, Chromium) on mem-cash; test:browser:regtest on Docker
pnpm typecheck      # tsc --noEmit over src and test
pnpm lint           # oxlint, type-aware (.oxlintrc.json); correctness and promise rules are errors
pnpm format         # oxfmt (format:check in CI)
pnpm build          # tsc -p tsconfig.build.json to dist/
```

Run one file: `USE_MOCK_PROVIDER=1 pnpm exec vitest run --config test/vitest.config.ts src/wallet/HDWallet.test.ts`.

## Layout

- `src/wallet/`: the wallet classes. `Base.ts` (`BaseWallet`: sending, token operations, history, watching), `Watch.ts` (watch-only), `Wif.ts` (single-address), `HDWallet.ts` (HD, address discovery over subscriptions, multiple derivation branches).
- `src/transaction/`: transaction building, coin selection and fees (`Wif.ts`), and the token conservation check (`tokenConservation.ts`).
- `src/network/`: `ElectrumNetworkProvider` (the provider wallets talk to) over a `Transport`, `ElectrumTransport` (that transport over electrum-cash), `default.ts` (global providers per network), `MockNetworkProvider` (the in-memory chain used by `pnpm test`, test infrastructure left out of the build; tests set up providers through `test/providers.ts`).
- `src/cache/`: the IndexedDB cache (`Config.UseIndexedDBCache`), and `walletCache` (HD address and key cache).
- `src/db/`: `StorageProvider` (wallet persistence). `src/indexeddb/`: the browser `IndexedDBProvider`.
- `src/history/`, `src/message/`, `src/rate/`, `src/util/`: history decoding, signed messages, exchange rates, helpers.
- `src/index.ts`: the public API, explicit exports. Whatever is exported there is API.

## Tests

- The default suite runs on `@paryonusd/mem-cash` (a private npm package, pinned exactly; its source is at `~/ParyonUSD/paryon_mem_cash`, read-only for you), an in-memory Electrum server and BCH VM that follows BCHN and Fulcrum closely (Fulcrum's listunspent and history order, BCHN's refusal reasons), run here with the May 2026 rules. Don't write tests that depend on insertion order where Fulcrum defines another. Use it for every change: wallets are funded on it, transactions are validated by it, and a test can broadcast and read back.
- A fix comes with a test that fails without it. For coin selection, change and fees, assert the actual transaction (inputs, outputs, amounts, token data), not just that a send succeeded.
- Tests that need the Docker regtest (BCHN + Fulcrum) are skipped in mock mode; don't add new ones of that kind when mem-cash can do it.
- `pnpm test` and `pnpm test:browser` run offline. A test whose result depends on a public service (mainnet or chipnet electrum, exchange-rate APIs) is marked with `test.skipIf(!liveTests)` from `test/live.ts`: it runs only with `LIVE_TESTS=1` (e.g. `LIVE_TESTS=1 pnpm test`), on the Docker regtest as well. Prefer mem-cash or a fetch mock (`test/fetch.ts`) over a new live test.

## Code style

- **Check related code first**: follow existing patterns, avoid duplicating a helper that exists.
- **Prefer minimalism**: the smallest change that fixes the problem; no drive-by refactors in a fix commit.
- **Practical security focus**: real concerns over theoretical edge cases.
- **Readable over clever**: simple assignment plus a conditional override rather than nested ternaries.
- **Never await in argument position**: `f(await g(), x)` hides the I/O behind f's name; assign it first.
- **Comments earn their place**: context that isn't local to the code, a low-level detail, or a design note; not a restatement of the code. No paragraphs.
- **Errors**: throw `Error` objects (never strings); don't put key material (WIFs, seeds, private keys) in error messages or logs.

## Persistent storage is frozen

Cashonize is a live wallet: its users' browsers hold data written by mainnet-js 3.1.7 (the wallet databases `bitcoincash`/`bchtest` at version 31, the `WalletCache` and electrum caches at version 1, the stored wallet ids, the `walletCache-…` keys and record shapes, the localStorage keys). The library must read all of it as it is, and keep writing it in a form that mainnet-js 3.1.7 can still read, so an app rollback doesn't lose wallets. No breaking change to database names, store names, versions, key formats, wallet id formats or record shapes. A new record type is allowed only when it is needed, never one that holds key material, and old records are never rewritten into a new form.

## Conventions

- **Errors**: throw exported `Error` subclasses (in `src/wallet/errors.ts`, or next to the transport for network errors) with `name` set, structured fields for what a caller branches on (`asset`, `category`, `utxoId`, `reason`, …) and the underlying error as `cause`. Callers tell errors apart with `instanceof` and fields, never by matching the message. Never throw strings or reject with non-Errors.
  A bad app-wide setting (a `Config.RelayFeePerByte` that is not a finite, non-negative number) is a programmer error and stays a plain `Error` naming the setting: no caller branches on it.
- **Options**: per-call options go in an options object, the last parameter; the library never mutates it. A per-call option overrides `Config`. `Config` is for app-wide defaults only; new behavior gets a per-call option first. Values that are fixed for a wallet's life (provider, derivation) are factory options.
- **Which coins a spend uses**: the pool is the wallet's current coins, narrowed to `utxoIds` when given, its token coins narrowed to `tokenUtxoIds` when given, minus `excludeUtxoIds`. Every coin a spend uses comes from that pool: `ensureUtxos` and the inputs a token operation picks itself. A coin named in `ensureUtxos` that is not in the pool is an error before anything is built, never a silent addition. This holds for `send`, `sendMax`, `getMaxAmountToSend`, `tokenGenesis`, `tokenMint` and `tokenBurn`.
- **Concurrency**: the caller decides how many requests run at once. Where the library fans out itself (history, raw transactions, headers), it is bounded, never one unbounded `Promise.all` over a list that grows with the wallet.
- **Reads have no side effects**: existence checks and lookups construct no wallet, open no subscription and write nothing.

## Public API

Keep exported names and signatures unless the fix needs to change them. Every API or behavior change goes in `CHANGELOG.md` under "Unreleased", with what a caller has to change.

`docs/api-surface.md` lists every export, public member and option group with who needs it. A new export needs a line there and a real consumer (a Cashonize use, or a library-internal reason it has to be public); a removal takes its line out.

## Commits

- One logical change per commit. Summary line in lowercase, describing the change in plain words (e.g. "make tokenMint honor utxoIds"); the body says why, and what was broken before.
- End with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never add a Claude session link trailer.
- Upstream mainnet-js issue numbers are referenced as `mainnet-js#NNN`.
