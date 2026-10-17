# Changelog

## Unreleased

Starting point: mainnet-js `4.0.0-next.14` (`next` @ `9ec2a0e`), plus mainnet-js#244 (128-byte NFT commitments).

### Changes for callers coming from mainnet-js

- Package name `bch-wallet-lib`; `@mainnet-cash/indexeddb-storage` is now the `bch-wallet-lib/indexeddb` subpath export.
- The CLI (`src/cli.ts`) and the browser bundle are not shipped.
- The Electrum transport is `@electrum-cash/network` with `@electrum-cash/web-socket` instead of `@rpckit/*`:
  - Servers are plain URLs, `wss://host:port` or `ws://host:port`. `createProvider(network, servers?, options?)` and `DefaultProvider.servers.<network>` take one URL, several separated by commas, or an array (`getDefaultServers` now returns an array). A list is tried in order when connecting, and the provider stays with the first server that connects: after a failure electrum-cash reconnects to that server and restores its subscriptions there. rpckit's notation (`fallback(...)`, `?timeout=…&batchSize=…` options) is rejected with an Error, and requests are no longer batched.
  - `new ElectrumNetworkProvider(transport, network)` takes a `Transport`, the new interface of what the provider needs (`connect`, `close`, `request`, `subscribe`), e.g. `new ElectrumTransport("wss://host:50004")`. The class is no longer generic over an rpckit schema, and `performRequest<T>(method, params)` / `subscribeRequest(method, params, callback)` take the result type from the caller instead of the schema.
  - Every server gets a connect timeout (10 s) and a request timeout (30 s), a single user-supplied URL included (mainnet-js#251); `ElectrumTransportOptions` (`connectTimeout`, `requestTimeout`, in ms) is the third argument of `createProvider`. A timed out request rejects with an `ElectrumTimeoutError`, no longer with the string `"electrum-cash request timed out, retrying"`. A request that times out or loses its connection is sent once more, now really re-sent on a (re)connected server rather than awaited again; a broadcast is not, and an error response from the server is never retried. Errors are always `Error` objects.
  - In a browser the socket stays connected while the page is hidden and ignores online/offline events; it reconnects when the connection actually fails. In Node, TLS certificates are verified.
  - Protocol version 1.5 is asked of every server (mainnet asked for 1.6), as electrum-cash only accepts the exact version it asks for and chipnet servers stop at 1.5.
  - `daemonPassthrough()` is removed: Fulcrum's `daemon.passthrough` takes named params, which electrum-cash cannot send. The regtest `mine()` calls the node's RPC directly, with the `RPC_*` environment of the regtest (as mainnet-js 3 did).
  - New exports: `ElectrumTransport`, `ElectrumTimeoutError`, and the types `ElectrumServer`, `ElectrumTransportOptions`, `Transport`, `Unsubscribe`.
- `initProviders` / `disconnectProviders` no longer throw a `ReferenceError` in a browser that has no global `process` (mainnet-js#251).
