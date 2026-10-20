// Checks that a rollback to mainnet-js 3.1.7 still works: the library (its build in dist/) stores
// and opens the wallets of walletSpecs as Cashonize does, then 3.1.7 opens the same storage, then
// the library once more. Every wallet must come back with the same addresses and keys, and both
// must reuse the HD caches the other wrote. See README.md.
import "fake-indexeddb/auto";
import assert from "assert/strict";
import { mkdtempSync } from "fs";
import { LocalStorage } from "node-localstorage";
import { tmpdir } from "os";
import path from "path";
import { pathToFileURL } from "url";
import {
  buildChain,
  delay,
  dumpIndexedDB,
  FakeElectrumClient,
  FakeTransport,
  NETWORKS,
  STANDARD,
  walletSpecs,
} from "./shared.mjs";

const CASHONIZE_MODULES =
  process.env.CASHONIZE_MODULES ??
  "/home/mrzwets/Cashonize/cashonize-wallet/node_modules";
const DIST = path.resolve(import.meta.dirname, "../../../dist");

globalThis.localStorage = new LocalStorage(
  mkdtempSync(path.join(tmpdir(), "storage-rollback-")),
);

const lib = await import(pathToFileURL(path.join(DIST, "index.js")).href);
const { IndexedDBProvider: LibIndexedDBProvider } = await import(
  pathToFileURL(path.join(DIST, "indexeddb/index.js")).href
);
const old = await import(
  pathToFileURL(path.join(CASHONIZE_MODULES, "mainnet-js/dist/module/index.js"))
    .href
);
const { default: OldIndexedDBProvider } = await import(
  pathToFileURL(
    path.join(
      CASHONIZE_MODULES,
      "@mainnet-cash/indexeddb-storage/dist/module/IndexedDBProvider.js",
    ),
  ).href
);

const chains = Object.fromEntries(
  NETWORKS.map((info) => [info.network, buildChain(info)]),
);
// the addresses of the HD wallets that keep a cache record: a watch-only (xpub) one keeps none in
// either version, and fetches its addresses on every start
const hdAddresses = new Set(
  NETWORKS.flatMap((info) =>
    walletSpecs(info)
      .filter((spec) => spec.kind === "hd" && !/:[xt]pub/.test(spec.walletId))
      .flatMap((spec) => spec.used.map(({ address }) => address)),
  ),
);
const ticker = { mainnet: "BCH", testnet: "tBCH" };

/// Point a library's global providers at the fake chain; returns the requests made
function installProviders(makeProvider) {
  const requests = [];
  for (const { network } of NETWORKS) {
    globalThis[ticker[network]] = makeProvider(network, requests);
  }
  return requests;
}

function libProvider(network, requests) {
  const transport = new FakeTransport(chains[network]);
  const request = transport.request.bind(transport);
  transport.request = (method, params) => {
    requests.push({ method, address: params?.[0] });
    return request(method, params);
  };
  return new lib.ElectrumNetworkProvider(transport, network);
}

function oldProvider(network, requests) {
  const client = new FakeElectrumClient(chains[network]);
  const request = client.request.bind(client);
  client.request = (method, ...params) => {
    requests.push({ method, address: params[0] });
    return request(method, ...params);
  };
  return new old.ElectrumNetworkProvider(client, network);
}

const hex = (bytes) => (bytes ? Buffer.from(bytes).toString("hex") : null);

/// What a wallet derives, read the same way from both libraries
async function describeWallet(wallet, kind) {
  const common = {
    walletType: wallet.walletType,
    network: wallet.network,
    toDbString: wallet.toDbString(),
    balance: String(await wallet.getBalance()),
  };
  if (kind === "single") {
    return {
      ...common,
      cashaddr: wallet.cashaddr,
      tokenaddr: wallet.tokenaddr,
      privateKey: hex(wallet.privateKey),
    };
  }
  const branch = (change) => {
    const entries = [];
    for (let i = 0; i < 25; i++) {
      // 3.1.7 takes a boolean for the change branch, the library a branch number
      const entry = wallet.walletCache.getByIndex(
        i,
        wallet.indices ? Number(change) : change,
      );
      entries.push([entry.address, entry.tokenAddress, hex(entry.privateKey)]);
    }
    return entries;
  };
  return {
    ...common,
    xPub: wallet.xPub,
    cacheId: wallet.walletId,
    depositIndex: wallet.indices?.get(0) ?? wallet.depositIndex,
    changeIndex: wallet.indices?.get(1) ?? wallet.changeIndex,
    nextDepositAddress: wallet.getDepositAddress(),
    deposit: branch(false),
    change: branch(true),
  };
}

/// Open every wallet by name, as Cashonize does on start, and describe it
async function openAll(classes) {
  const described = {};
  const wallets = [];
  for (const info of NETWORKS) {
    for (const spec of walletSpecs(info)) {
      const wallet = await classes[info.network][spec.kind].named(spec.name);
      await wallet.watchPromise;
      wallets.push(wallet);
      described[`${info.dbName}/${spec.name}`] = await describeWallet(
        wallet,
        spec.kind,
      );
    }
  }
  // past the debounce of the cache writes
  await delay(2500);
  for (const wallet of wallets) await wallet.stop();
  return described;
}

function walletCacheRecords(dump) {
  const db = dump.find((d) => d.name === "WalletCache");
  return new Map(db.stores[0].records.map(({ key, value }) => [key, value]));
}

// 1. The library stores the wallets in both databases and opens them, as Cashonize would
lib.Config.UseIndexedDBCache = true;
lib.Config.DefaultParentDerivationPath = STANDARD;
lib.BaseWallet.StorageProvider = LibIndexedDBProvider;
const libClasses = {
  mainnet: { single: lib.Wallet, hd: lib.HDWallet },
  testnet: { single: lib.TestNetWallet, hd: lib.TestNetHDWallet },
};
installProviders(libProvider);
for (const info of NETWORKS) {
  for (const spec of walletSpecs(info)) {
    const stored = await libClasses[info.network][spec.kind].replaceNamed(
      spec.name,
      spec.walletId,
    );
    await stored.watchPromise;
    await stored.stop();
  }
}
const byLibrary = await openAll(libClasses);
for (const { network } of NETWORKS) {
  const provider = globalThis[ticker[network]];
  const txids = Object.keys(chains[network].transactions).sort();
  await provider.connect();
  await provider.getRawTransactions(txids.slice(0, 2));
  await provider.getRawTransactionObject(txids[3]);
  await provider.getHeaders([chains[network].height - 3]);
}
// in Node the library caches rates in the global scope; for this call it sees a browser, and
// caches in localStorage as Cashonize does
lib.Config.GetExchangeRateFn = async () => 400.25;
const nodeGlobal = globalThis.global;
delete globalThis.global;
globalThis.document = {};
try {
  await lib.ExchangeRate.getQuote("usd");
} finally {
  globalThis.global = nodeGlobal;
  delete globalThis.document;
}
assert.ok(localStorage.getItem("rate-usd"), "the library cached the rate");
const writtenByLibrary = await dumpIndexedDB();
const libRecords = walletCacheRecords(writtenByLibrary);
assert.ok(libRecords.size > 0, "the library wrote HD cache records");
for (const value of libRecords.values()) {
  assert.deepEqual(Object.keys(JSON.parse(value)), [
    "walletCache",
    "indexCache",
  ]);
}

// 2. Rollback: mainnet-js 3.1.7 opens the same storage
old.Config.UseIndexedDBCache = true;
old.Config.DefaultParentDerivationPath = STANDARD;
old.BaseWallet.StorageProvider = OldIndexedDBProvider;
const oldClasses = {
  mainnet: { single: old.Wallet, hd: old.HDWallet },
  testnet: { single: old.TestNetWallet, hd: old.TestNetHDWallet },
};
const oldRequests = installProviders(oldProvider);
const by317 = await openAll(oldClasses);
assert.deepEqual(by317, byLibrary, "3.1.7 opens the wallets as the library");
assert.deepEqual(
  oldRequests.filter(
    (req) =>
      req.method !== "blockchain.address.subscribe" &&
      hdAddresses.has(req.address),
  ),
  [],
  "3.1.7 reuses the HD caches the library wrote",
);
for (const { network } of NETWORKS) {
  const provider = globalThis[ticker[network]];
  const txids = Object.keys(chains[network].transactions).sort();
  const before = oldRequests.length;
  const raw = await provider.getRawTransactions(txids.slice(0, 2));
  assert.equal(raw.get(txids[0]), chains[network].transactions[txids[0]]);
  const verbose = await provider.getRawTransaction(txids[3], true);
  assert.equal(verbose.hex, chains[network].transactions[txids[3]]);
  const headers = await provider.getHeaders([chains[network].height - 3]);
  assert.equal(
    headers.get(chains[network].height - 3).height,
    chains[network].height - 3,
  );
  assert.deepEqual(
    oldRequests
      .slice(before)
      .filter((req) => req.method !== "blockchain.headers.subscribe"),
    [],
    "3.1.7 reads the electrum caches the library wrote",
  );
}
old.Config.GetExchangeRateFn = async () => {
  throw new Error("the cached rate should be used");
};
assert.equal(await old.ExchangeRate.getRateFromLocalStorage("usd"), 400.25);
const writtenBy317 = await dumpIndexedDB();
for (const [key, value] of walletCacheRecords(writtenBy317)) {
  // 3.1.7 carries what it loads forward, and adds nothing the library would not read
  assert.deepEqual(
    Object.keys(JSON.parse(value)),
    ["walletCache", "indexCache"],
    key,
  );
}

// 3. And forward again: the library opens what 3.1.7 left
const libRequests = installProviders(libProvider);
const again = await openAll(libClasses);
assert.deepEqual(again, byLibrary, "the library opens the wallets again");
assert.deepEqual(
  libRequests.filter(
    (req) =>
      req.method !== "blockchain.address.subscribe" &&
      hdAddresses.has(req.address),
  ),
  [],
  "the library reuses the HD caches after the rollback",
);

console.log(
  `rollback ok: ${Object.keys(byLibrary).length} wallets, ${libRecords.size} HD cache records`,
);
process.exit(0);
