# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

bch-wallet-lib is a Bitcoin Cash wallet library, continued from mainnet-js `4.0.0-next.14`. Its first user is the Cashonize wallet (`~/Cashonize/cashonize-wallet`), which runs it in browsers, Electron and Capacitor. Key material, signing and coin selection live here, so this is security-critical code: being overly careful is preferred over under-careful.

## Commands

```bash
pnpm test           # vitest on the in-memory chain (mem-cash); the default, no Docker
pnpm test:regtest   # the same suite against BCHN + Fulcrum in Docker
pnpm test:browser   # browser tests (vitest browser mode, Chromium)
pnpm typecheck      # tsc --noEmit over src and test
pnpm lint           # oxlint --type-aware
pnpm format         # oxfmt (format:check in CI)
pnpm build          # tsc -p tsconfig.build.json to dist/
```

Run one file: `USE_MOCK_PROVIDER=1 pnpm exec vitest run --config test/vitest.config.ts src/wallet/HDWallet.test.ts`.

## Layout

- `src/wallet/`: the wallet classes. `Base.ts` (`BaseWallet`: sending, token operations, history, watching), `Watch.ts` (watch-only), `Wif.ts` (single-address), `HDWallet.ts` (HD, address discovery over subscriptions, multiple derivation branches).
- `src/transaction/`: transaction building (`Wif.ts`), fee allocation, and `coin-control/` (selection, input/output order, fee strategies; the `bch-wallet-lib/coin-control` entry).
- `src/network/`: `ElectrumNetworkProvider` (the provider wallets talk to), `default.ts` (global providers per network), `MockNetworkProvider` (the in-memory chain used by `pnpm test`).
- `src/cache/`: IndexedDB / web storage / memory caches, and `walletCache` (HD address and key cache).
- `src/db/`: `StorageProvider` (wallet persistence), `EncryptedStorageProvider`. `src/indexeddb/`: the browser `IndexedDBProvider`.
- `src/history/`, `src/message/`, `src/rate/`, `src/util/`: history decoding, signed messages, exchange rates, helpers.
- `src/index.ts`: the public API, explicit exports. Whatever is exported there is API.

## Tests

- The default suite runs on `@paryonusd/mem-cash` (local checkout `~/ParyonUSD/paryon_mem_cash`, read-only for you), an in-memory Electrum server and BCH VM that follows BCHN and Fulcrum closely (Fulcrum's listunspent and history order, BCHN's refusal reasons), run here with the May 2026 rules. Don't write tests that depend on insertion order where Fulcrum defines another. Use it for every change: wallets are funded on it, transactions are validated by it, and a test can broadcast and read back.
- A fix comes with a test that fails without it. For coin selection, change and fees, assert the actual transaction (inputs, outputs, amounts, token data), not just that a send succeeded.
- Tests that need the Docker regtest (BCHN + Fulcrum) are skipped in mock mode; don't add new ones of that kind when mem-cash can do it.

## Code style

- **Check related code first**: follow existing patterns, avoid duplicating a helper that exists.
- **Prefer minimalism**: the smallest change that fixes the problem; no drive-by refactors in a fix commit.
- **Practical security focus**: real concerns over theoretical edge cases.
- **Readable over clever**: simple assignment plus a conditional override rather than nested ternaries.
- **Never await in argument position**: `f(await g(), x)` hides the I/O behind f's name; assign it first.
- **Comments earn their place**: context that isn't local to the code, a low-level detail, or a design note; not a restatement of the code. No paragraphs.
- **Errors**: throw `Error` objects (never strings); don't put key material (WIFs, seeds, private keys) in error messages or logs.

## Public API

Keep exported names and signatures unless the fix needs to change them. Every API or behavior change goes in `CHANGELOG.md` under "Unreleased", with what a caller has to change.

## Commits

- One logical change per commit. Summary line in lowercase, describing the change in plain words (e.g. "make tokenMint honor utxoIds"); the body says why, and what was broken before.
- End with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never add a Claude session link trailer.
- Upstream mainnet-js issue numbers are referenced as `mainnet-js#NNN`.
