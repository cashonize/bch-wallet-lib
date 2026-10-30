# Electrum failover

`createFailoverProvider` gives a provider over an ordered list of servers that moves to another one when the server in use stays lost or (with `staleTipSeconds`) stops following the chain. This file says why it works the way it does and why it lives in the library. The code is `src/network/FailoverTransport.ts`; the option docs are on `FailoverTransportOptions`.

## The trust it has to respect

Electrum data is not verified: there is no SPV, so every server on a list is trusted for balances, history, confirmations and the tip. A list is therefore not redundancy for free; it is more operators trusted. A lying or lagging server cannot steal (signing is local, BCH signatures commit to every spent output's value and token data), but it can fake or hide payments, censor a broadcast and serve a stale tip.

Privacy is the larger cost. An HD wallet subscribes every address on one connection, so the server links them all, and each switch hands the whole set to one more operator. The rules follow from that:

- **One server at a time, sticky.** Requests and subscriptions all go to the server in use. Nothing switches to chase latency or spread load.
- **No switch on a blip.** A lost server gets a grace period (electrum-cash's 5 s reconnect plus the connect timeout) and then one reconnect of its own before any other server is tried. Safari/iOS kills the sockets of background tabs; a device back online would otherwise hand the wallet to whichever server answers first.
- **No switch while offline.** A device without network fails every server alike.
- **Candidates are checked before they learn anything.** A candidate is asked for its tip, which reveals no address, and is skipped when more than one block below the highest tip seen: an HD wallet takes a null status for an unused address and drops its coins, so a server that is behind can empty addresses. A candidate that refuses a subscription ends the switch, so one switch shows the addresses to at most one more server.
- **A candidate on another chain is refused.** Each network's registry entry names its chain: a checkpoint block after the last split from another chain, or else the genesis. Chipnet and testnet4 share a genesis and both use `bchtest` addresses, so a chipnet server in a testnet4 list (or the reverse) would otherwise be taken and shown every address. The check is one header request, before any subscription.
- **One server means one server.** A list of one never contacts anything else.
- **No peer discovery.** Electron Cash learns servers from `server.peers.subscribe` and can afford to, because it verifies headers and merkle proofs. Without SPV the list must stay curated by the app.

## Why in the library, and in the transport

The alternative built and compared against this one kept one server per provider and let the app switch with `wallet.setProvider` on a connection signal. It failed on what the app cannot do without reaching into every caller: a provider swapped under running work leaves that work failing on a closed transport, so the app reloaded the whole wallet on every switch (balance, history, dApp connections), and every lookup that took the provider as an argument had to be moved by hand. Inside the transport the provider object never changes: wallets, the global provider and every holder of it follow a switch without knowing, and a request lost to the switch is sent once more on the new server (never a broadcast).

`FailoverTransport` wraps whole single-server `ElectrumTransport`s rather than switching clients inside one: each is closed for good once left, so the reconnect, retry and close semantics of `ElectrumTransport` stay as they are, and nothing reconnects to a server the transport has left.

Not done, and why:

- **A cluster or quorum** (several servers answering one request): electrum-cash removed `ElectrumCluster`, and mainnet-js 2 dropped it after subscriptions to the same method made all members unresponsive.
- **Per-request failover with ranking**, as mainnet-js 4 does with rpckit's fallback (connect to all, ping all every 4 s, send each request to the best-ranked server): fast, but every server sees the IP and in time the addresses, answers can come from different servers with nothing reconciling them, and subscriptions are not moved when their server dies.

## Limits

- At startup no tip has been seen, so the first reachable server is not lag-checked.
- A candidate one block behind, or one whose mempool lacks a transaction, still passes, so a null status can still reach an HD wallet on a switch.
- While the server in use stays lost, the other servers are probed every grace period (IP and a tip request, no addresses).
- Requests that fail while the server is lost, before a switch, reject as with `ElectrumTransport`.
