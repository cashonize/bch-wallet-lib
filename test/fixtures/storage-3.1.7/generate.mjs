// Writes v3.1.7.json: the IndexedDB databases and localStorage keys that mainnet-js 3.1.7 leaves
// in a Cashonize user's browser, and what 3.1.7 derives from them. See README.md.
import "fake-indexeddb/auto";
import { mkdtempSync, writeFileSync } from "fs";
import { LocalStorage } from "node-localstorage";
import { tmpdir } from "os";
import path from "path";
import { pathToFileURL } from "url";
import {
  buildChain,
  delay,
  dumpIndexedDB,
  dumpLocalStorage,
  FakeElectrumClient,
  NETWORKS,
  STANDARD,
  walletSpecs,
} from "./shared.mjs";

const CASHONIZE_MODULES =
  process.env.CASHONIZE_MODULES ??
  "/home/mrzwets/Cashonize/cashonize-wallet/node_modules";

globalThis.localStorage = new LocalStorage(
  mkdtempSync(path.join(tmpdir(), "storage-3.1.7-")),
);

const mainnet = await import(
  pathToFileURL(path.join(CASHONIZE_MODULES, "mainnet-js/dist/module/index.js"))
    .href
);
const { default: IndexedDBProvider } = await import(
  pathToFileURL(
    path.join(
      CASHONIZE_MODULES,
      "@mainnet-cash/indexeddb-storage/dist/module/IndexedDBProvider.js",
    ),
  ).href
);
const {
  BaseWallet,
  Config,
  ElectrumNetworkProvider,
  ExchangeRate,
  HDWallet,
  TestNetHDWallet,
  TestNetWallet,
  Wallet,
} = mainnet;

// Cashonize's mainnet-js configuration (store.ts)
Config.EnforceCashTokenReceiptAddresses = true;
Config.UseIndexedDBCache = true;
BaseWallet.StorageProvider = IndexedDBProvider;
// createNewWallet / createNewHDWallet set it before the first wallet is made, and it stays set
Config.DefaultParentDerivationPath = STANDARD;

const chains = {};
const providers = {};
for (const info of NETWORKS) {
  chains[info.network] = buildChain(info);
  providers[info.network] = new ElectrumNetworkProvider(
    new FakeElectrumClient(chains[info.network]),
    info.network,
  );
  // the global provider mainnet-js hands every wallet of that network (network/default.js)
  globalThis[info.network === "mainnet" ? "BCH" : "tBCH"] =
    providers[info.network];
}

const classes = {
  mainnet: { single: Wallet, hd: HDWallet },
  testnet: { single: TestNetWallet, hd: TestNetHDWallet },
};

// Store every wallet in both databases, as Cashonize's create and import flows do
for (const info of NETWORKS) {
  for (const spec of walletSpecs(info)) {
    const WalletClass = classes[info.network][spec.kind];
    const stored = await WalletClass.replaceNamed(spec.name, spec.walletId);
    // replaceNamed constructs the wallet, which starts an HD wallet's discovery
    await stored.watchPromise;
    await stored.stop();
  }
}

// Then open each of them by name, as the app does on every start and network switch
const wallets = [];
for (const info of NETWORKS) {
  for (const spec of walletSpecs(info)) {
    const WalletClass = classes[info.network][spec.kind];
    const wallet = await WalletClass.named(spec.name);
    wallets.push({ info, spec, wallet });
  }
}
for (const { wallet } of wallets) await wallet.watchPromise;
// let the HD caches' debounced writes (2 s) land
await delay(2500);

function hex(bytes) {
  return bytes ? Buffer.from(bytes).toString("hex") : null;
}

async function expectedOf({ spec, wallet }) {
  const common = {
    kind: spec.kind,
    walletType: wallet.walletType,
    network: wallet.network,
    name: wallet.name,
    toDbString: wallet.toDbString(),
    toString: wallet.toString(),
    balance: (await wallet.getBalance()).toString(),
    utxos: (await wallet.getUtxos())
      .map((utxo) => `${utxo.txid}:${utxo.vout}`)
      .sort(),
  };
  if (spec.kind === "single") {
    return {
      ...common,
      cashaddr: wallet.cashaddr,
      tokenaddr: wallet.tokenaddr,
      depositAddress: wallet.getDepositAddress(),
      changeAddress: wallet.getChangeAddress(),
      publicKeyHash: hex(wallet.publicKeyHash),
      privateKey: hex(wallet.privateKey),
      privateKeyWif: wallet.privateKeyWif ?? null,
      mnemonic: wallet.mnemonic ?? null,
      derivationPath: wallet.mnemonic ? wallet.derivationPath : null,
    };
  }
  const deposit = [];
  const change = [];
  for (let i = 0; i < 25; i++) {
    const entry = wallet.walletCache.getByIndex(i, false);
    deposit.push({
      address: entry.address,
      tokenAddress: entry.tokenAddress,
      privateKey: hex(entry.privateKey),
    });
  }
  for (let i = 0; i < 5; i++) {
    const entry = wallet.walletCache.getByIndex(i, true);
    change.push({
      address: entry.address,
      tokenAddress: entry.tokenAddress,
      privateKey: hex(entry.privateKey),
    });
  }
  return {
    ...common,
    mnemonic: wallet.mnemonic ?? null,
    derivation: wallet.mnemonic ? wallet.derivation : null,
    xPub: wallet.xPub,
    xPriv: wallet.xPriv ?? null,
    cacheId: wallet.walletId,
    depositIndex: wallet.depositIndex,
    changeIndex: wallet.changeIndex,
    nextDepositAddress: wallet.getDepositAddress(),
    nextChangeAddress: wallet.getChangeAddress(),
    deposit,
    change,
  };
}

const expected = { bitcoincash: {}, bchtest: {} };
for (const entry of wallets) {
  expected[entry.info.dbName][entry.spec.name] = await expectedOf(entry);
}
for (const { wallet } of wallets) await wallet.stop();

// The electrum caches: raw and verbose transactions, headers (store "ElectrumNetworkProviderCache")
const electrumCache = {};
for (const info of NETWORKS) {
  const provider = providers[info.network];
  const txids = Object.keys(chains[info.network].transactions).sort();
  await provider.getRawTransactions(txids.slice(0, 2));
  await provider.getRawTransaction(txids[2]);
  await provider.getRawTransaction(txids[3], true);
  await provider.getHeader(chains[info.network].height - 1);
  await provider.getHeader(chains[info.network].height - 2, true);
  await provider.getHeaders([chains[info.network].height - 3]);
  electrumCache[info.network] = {
    rawTransactions: txids.slice(0, 3),
    verboseTransaction: txids[3],
    header: chains[info.network].height - 1,
    verboseHeaders: [
      chains[info.network].height - 2,
      chains[info.network].height - 3,
    ],
  };
}

// The exchange rate cache 3.1.7 keeps in a browser's localStorage (rate-<symbol>); in Node it only
// takes the global scope path, so the browser path is called directly
Config.GetExchangeRateFn = async () => 500.5;
const realNow = Date.now;
Date.now = () => 1760000000000;
await ExchangeRate.getRateFromLocalStorage("usd");
Date.now = realNow;

const fixture = {
  about:
    "Written by generate.mjs with mainnet-js 3.1.7 (Cashonize's patched copy) and @mainnet-cash/indexeddb-storage 3.1.7, configured as Cashonize configures them, against a fake electrum server. Test keys only.",
  chain: chains,
  electrumCache,
  expected,
  indexedDB: await dumpIndexedDB(),
  localStorage: dumpLocalStorage(),
};

const out = path.join(import.meta.dirname, "v3.1.7.json");
writeFileSync(
  out,
  JSON.stringify(
    fixture,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  ) + "\n",
);
console.log(`wrote ${out}`);
process.exit(0);
