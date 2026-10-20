# Testing

How the library is tested, what each layer can and cannot catch, and what is still missing. How to run each suite is in the README.

The library moves money, and most of it was written and reviewed by agents, so a passing test written by the same author says less than usual. The layers below are ordered by cost; the ones still to build are there because a layer above has a known blind spot.

## Layers

### 1. Unit tests on mem-cash (`pnpm test`)

The suite runs on an in-memory chain (`@paryonusd/mem-cash`, BCH_2026_05 VM) behind the real `ElectrumNetworkProvider`. Fast and offline (`LIVE_TESTS` unset opens no public server).

Blind spot: mem-cash is not Fulcrum. It answers instantly and in order, so timing bugs pass: the HD consecutive-send bug (fixed in `6ddaa58` of the `archive/dev-history` branch) failed 10 of 10 on a real chain and passed here until the tests slowed mem-cash down on purpose. The scenarios are also only the ones the author thought of.

### 2. Regtest on BCHN + Fulcrum (`pnpm test:regtest`, `pnpm test:regtest:local`)

The same suite against a real node and a real Fulcrum: relay and dust policy, mempool conflicts, Fulcrum's subscription timing and token reporting. Docker (pat's setup, for CI) or local binaries (for development). About 9 minutes.

Not covered on a real chain yet:

- HD wallets with tokens and the coin options (`utxoIds`, `excludeUtxoIds`, `ensureUtxos`, `tokenUtxoIds`), HD burns, HD wallets with hundreds of token coins past the gap limit.
- Reconnects, provider switching and watch errors: those files always build a mem-cash provider.
- Chain events: reorgs, a conflicting spend from another wallet on the same keys, Fulcrum stopping mid-send (the broadcast timeout), failover. `paryon_regtest` (`~/ParyonUSD/paryon_regtest`) already has reorg, partition and Fulcrum stop controls and a three-node layout; a chaos file could drive it, on its own data directory, never `~/BCH-infra/regtest`.
- Immature coinbases in coin selection.
- Regtest is not in CI.

### 3. Storage compatibility (`src/storage-3.1.7.test.ts`, `test/fixtures/storage-3.1.7/`)

A fixture written by real mainnet-js 3.1.7 (`generate.mjs`) must load unchanged, and `rollback.mjs` checks that 3.1.7 still reads what the library writes. Missing: `rollback.mjs` in CI, more fixtures (many wallets, both databases, odd names, partial HD caches), and real browser profiles copied from installs (web, Electron, Android) upgraded and rolled back by hand.

### 4. Property-based fuzzing of the spend path (to build, first)

fast-check on mem-cash: random wallets (BCH, FT, NFT and FT+NFT coins, minting NFTs, dust-sized coins, a random reserved set, hundreds of coins, single-address and HD) and random requests (send, sendMax, genesis, mint, burn, mixed token requests, with random `utxoIds`, `excludeUtxoIds`, `ensureUtxos`, `tokenUtxoIds`). Every built transaction must:

- spend no excluded coin and every `ensureUtxos` coin, and only coins of the pool;
- conserve tokens, except an explicit burn allowance and genesis or minting;
- carry exactly the requested outputs, with change to the wallet and never below dust;
- pay a fee between the relay minimum and the cap;
- pass libauth's VM and be accepted by mem-cash.

A request that cannot be met must fail with a typed error, never a plain `Error` or a crash. This finds the combination nobody wrote a test for, which is what mainnet-js#247 was, and does not depend on the author's imagination. Shrunk failures become ordinary unit tests.

### 5. Differential testing against 3.1.7 (to build)

The same wallet state and request through mainnet-js 3.1.7 and the library. For BCH-only sends the outputs must be equivalent; for token sends every difference must be one of the known fixes (mainnet-js#246, #247, #253). Any other difference is a regression of the rewrite. 3.1.7 is in Cashonize's `node_modules`; the HD consecutive-send check already ran it against the local regtest this way.

### 6. Mutation testing (occasionally)

Stryker on `src/wallet/Base.ts` (coin pool, selection, change), `src/transaction/tokenConservation.ts` and `src/transaction/Wif.ts`. A mutant that survives (a flipped comparison, a dropped filter) marks a check no test really guards. Run before a release, not in CI.

### 7. Adversarial server (to build)

Electrum data is not verified, so the server is untrusted input. A mem-cash wrapper that lies: wrong coin values, invented or dropped token data, coins of other addresses, malformed or out-of-order responses. Sighash covers input values and token data, so the result must be a refused signature or a typed error, never a valid transaction paying out different amounts than shown. Also covers the out-of-order status responses left open in the send fix.

## Outside the library

- **Cashonize unit tests** run the store's spend paths on a real library wallet (`test/store.reservedSpends.test.ts`), so reservations are checked against the real coin selection.
- **Cashonize e2e** (Playwright) covers the dApp connections only. Sends and token operations in the browser need a regtest network in the app (cashonize#368), or run on chipnet.
- **Chipnet, manual, last**: genesis with a reserve, FT and NFT sends, a mutable NFT whose coin moved, burns, reservations and pledges, an identity update, sendMax with tokens present, transfer all on an HD wallet, a WalletConnect, CashConnect and WizardConnect sign, an existing install upgraded and rolled back.
- **Human review** of the send, token, cache and transport code before Cashonize ships on the library. No layer above replaces it.

## CI

`check` and `browser` jobs. Missing: the Docker regtest job and `rollback.mjs`.
