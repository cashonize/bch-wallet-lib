# Changelog

## Unreleased

Starting point: mainnet-js `4.0.0-next.14` (`next` @ `9ec2a0e`), plus mainnet-js#244 (128-byte NFT commitments).

### Changes for callers coming from mainnet-js

- Package name `bch-wallet-lib`; `@mainnet-cash/indexeddb-storage` is now the `bch-wallet-lib/indexeddb` subpath export.
- The CLI (`src/cli.ts`) and the browser bundle are not shipped.
