# bch-wallet-lib

A Bitcoin Cash wallet library for browsers and Node: HD and single-address wallets, CashTokens, coin control, Electrum networking and pluggable wallet storage. Built on [libauth](https://libauth.org/).

bch-wallet-lib continues [mainnet-js](https://github.com/mainnet-cash/mainnet-js) by mainnet-cash, starting from `4.0.0-next.14` (`next` @ `9ec2a0e`). The REST server, the client generators and the postgres and BCMR packages stay with mainnet-js; the wallet engine and the IndexedDB storage provider continue here as one package.

Status: early, not yet published.

## Entry points

| Import                        | Contents                                                    |
| ----------------------------- | ----------------------------------------------------------- |
| `bch-wallet-lib`              | wallets, transactions, history, network provider, utilities |
| `bch-wallet-lib/indexeddb`    | `IndexedDBProvider`, wallet storage for browsers            |
| `bch-wallet-lib/coin-control` | coin selection, input and output ordering, fee strategies   |

## Development

Requires Node 22.12+ and pnpm 11.

The in-memory chain is [@paryonusd/mem-cash](https://github.com/ParyonUSD/paryon_mem_cash), a fork of mainnet-pat's mem-cash 0.0.9 that matches BCHN and Fulcrum more closely. It is a private npm package, so `pnpm install` needs an npm login with access to the `@paryonusd` scope (CI reads an `NPM_TOKEN` secret). It is a dev dependency only and never part of the published package. Only the tests import it (`src/network/MockNetworkProvider.ts`, left out of the build), and `pnpm check:dist-imports` (run in CI after the build) checks that no entry reaches it.

```bash
pnpm install
pnpm test           # unit and integration tests on the in-memory chain, no Docker
pnpm test:regtest   # the same suite against BCHN + Fulcrum in Docker (pnpm regtest:up first)
pnpm test:browser   # browser tests in headless Chromium, on the in-memory chain (pnpm exec playwright install chromium first)
pnpm typecheck
pnpm lint           # oxlint, type-aware
pnpm format         # oxfmt
pnpm build          # tsc to dist/
pnpm check:dist-imports  # after build: the entries import runtime dependencies only
```

## License

MIT. See [LICENSE](LICENSE); the original mainnet-js copyright notice is kept there.
