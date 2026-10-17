# bch-wallet-lib

A Bitcoin Cash wallet library for browsers and Node: HD and single-address wallets, CashTokens, coin control, Electrum networking and pluggable wallet storage. Built on [libauth](https://libauth.org/).

bch-wallet-lib continues [mainnet-js](https://github.com/mainnet-cash/mainnet-js) by mainnet-cash, starting from `4.0.0-next.14` (`next` @ `9ec2a0e`). The REST server, the client generators and the postgres and BCMR packages stay with mainnet-js; the wallet engine and the IndexedDB storage provider continue here as one package.

Status: early, not yet published.

## Entry points

| Import                     | Contents                                                    |
| -------------------------- | ----------------------------------------------------------- |
| `bch-wallet-lib`           | wallets, transactions, history, network provider, utilities |
| `bch-wallet-lib/indexeddb` | `IndexedDBProvider`, wallet storage for browsers            |

## Development

Requires Node 22.12+ and pnpm 11.

The in-memory chain is [@paryonusd/mem-cash](https://github.com/ParyonUSD/paryon_mem_cash), a fork of mainnet-pat's mem-cash 0.0.9 that matches BCHN and Fulcrum more closely. It is a private npm package, so `pnpm install` needs an npm login with access to the `@paryonusd` scope (CI reads an `NPM_TOKEN` secret). It is a dev dependency only and never part of the published package. Only the tests import it (`src/network/MockNetworkProvider.ts`, left out of the build), and `pnpm check:dist-imports` (run in CI after the build) checks that no entry reaches it.

```bash
pnpm install
pnpm test           # unit and integration tests on the in-memory chain, no Docker
pnpm test:regtest   # the same suite against BCHN + Fulcrum in Docker, started and stopped by the run
pnpm test:regtest:local  # the same, on local BCHN + Fulcrum binaries instead of Docker (below)
pnpm test:browser   # browser tests in headless Chromium, on the in-memory chain (pnpm exec playwright install chromium first)
pnpm typecheck
pnpm lint           # oxlint, type-aware
pnpm format         # oxfmt
pnpm build          # tsc to dist/
pnpm check:dist-imports  # after build: the entries import runtime dependencies only
```

### Regtest without Docker

`pnpm test:regtest:local` (and `test:browser:regtest:local`) starts the regtest the Docker setup describes on local binaries, runs the suite and stops it again: BCHN 29.1.0 or later (the May 2026 rules are active from block 1 on regtest; 29.0.0 needs `-upgrade12activationtime`) and Fulcrum 2.x, from `~/BCH-infra/bchn/bin/bitcoind` and `~/BCH-infra/fulcrum/Fulcrum` or `BITCOIND_PATH` and `FULCRUM_PATH`. Every start is a fresh chain with 815 blocks mined to the test address of `.env.regtest`, RPC `alice`/`password` on 127.0.0.1:18443, Fulcrum on 60001 (tcp) and 60003 (ws). The node binds to localhost and never dials a peer.

```bash
pnpm regtest:local:up     # start it by hand (fails if a port is taken)
SKIP_REGTEST_INIT=1 pnpm test:regtest:local src/wallet/Wif.test.ts   # run against it, leave it up
pnpm regtest:local:down
```

Each start makes a new directory `$REGTEST_DIR/run-<time>` (default `~/BCH-infra/regtest-bch-wallet-lib`, about 20 MB each) with the node's `debug.log` and `fulcrum.log`; `current` points at the last one. Old runs are not removed.

## License

MIT. See [LICENSE](LICENSE); the original mainnet-js copyright notice is kept there.
