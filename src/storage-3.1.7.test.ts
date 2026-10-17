import { binToHex } from "@bitauth/libauth";
import { readFileSync } from "fs";
import path from "path";
import { parse, WalletCacheI } from "./cache/walletCache.js";
import { Config } from "./config.js";
import ExchangeRateProvider from "./db/ExchangeRateProvider.js";
import IndexedDBProvider from "./indexeddb/IndexedDBProvider.js";
import { Network } from "./interface.js";
import { removeGlobalProvider, setGlobalProvider } from "./network/default.js";
import ElectrumNetworkProvider from "./network/ElectrumNetworkProvider.js";
import { Transport } from "./network/Transport.js";
import { BaseWallet } from "./wallet/Base.js";
import { HDWallet, TestNetHDWallet } from "./wallet/HDWallet.js";
import { TestNetWallet, Wallet } from "./wallet/Wif.js";

// What mainnet-js 3.1.7 left in a Cashonize user's browser, written by
// test/fixtures/storage-3.1.7/generate.mjs (see its README)
const fixture = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      "../test/fixtures/storage-3.1.7/v3.1.7.json",
    ),
    "utf8",
  ),
);

interface DumpedStore {
  name: string;
  keyPath: string | null;
  autoIncrement: boolean;
  records: { key: IDBValidKey; value: any }[];
}
interface DumpedDatabase {
  name: string;
  version: number;
  stores: DumpedStore[];
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadIndexedDB(dump: DumpedDatabase[]) {
  for (const { name, version, stores } of dump) {
    const open = indexedDB.open(name, version);
    open.onupgradeneeded = () => {
      for (const store of stores) {
        open.result.createObjectStore(store.name, {
          autoIncrement: store.autoIncrement,
          ...(store.keyPath === null ? {} : { keyPath: store.keyPath }),
        });
      }
    };
    const db = await request(open);
    for (const store of stores) {
      const tx = db.transaction(store.name, "readwrite");
      for (const { key, value } of store.records) {
        if (store.keyPath === null) tx.objectStore(store.name).put(value, key);
        else tx.objectStore(store.name).put(value);
      }
      await new Promise((resolve) => (tx.oncomplete = resolve));
    }
    db.close();
  }
}

async function dumpIndexedDB(): Promise<DumpedDatabase[]> {
  const databases = await indexedDB.databases();
  const dump: DumpedDatabase[] = [];
  for (const { name, version } of databases) {
    const db = await request(indexedDB.open(name!));
    const stores: DumpedStore[] = [];
    for (const storeName of db.objectStoreNames) {
      const store = db.transaction(storeName).objectStore(storeName);
      const keys = await request(store.getAllKeys());
      const values = await request(store.getAll());
      stores.push({
        name: storeName,
        keyPath: store.keyPath as string | null,
        autoIncrement: store.autoIncrement,
        records: keys.map((key, i) => ({ key, value: values[i] })),
      });
    }
    db.close();
    dump.push({ name: name!, version: version!, stores });
  }
  return dump.sort((a, b) => a.name.localeCompare(b.name));
}

const records = (dump: DumpedDatabase[], database: string) =>
  dump.find((db) => db.name === database)!.stores[0].records;

const cacheRecords = (dump: DumpedDatabase[]) =>
  new Map(
    records(dump, "WalletCache").map((r) => [
      r.key as string,
      r.value as string,
    ]),
  );

/// Serves the fixture's chain, counting the requests
class FixtureTransport implements Transport {
  requests: { method: string; params: any[] }[] = [];
  constructor(private chain: any) {}
  async connect() {}
  async close() {}
  async request(method: string, params: any[] = []) {
    this.requests.push({ method, params });
    return this.answer(method, params);
  }
  async subscribe(method: string, params: any[], onData: (data: any) => void) {
    onData([...params, this.answer(method, params)]);
    return async () => {};
  }
  private answer(method: string, params: any[]) {
    const [first, fromHeight = 0] = params;
    const address = this.chain.addresses[first];
    switch (method) {
      case "blockchain.address.subscribe":
        return address?.status ?? null;
      case "blockchain.address.listunspent":
        return structuredClone(address?.utxos ?? []);
      case "blockchain.address.get_history":
        return (address?.history ?? []).filter(
          (tx: any) => tx.height <= 0 || tx.height >= fromHeight,
        );
      case "blockchain.headers.subscribe":
        return this.chain.header;
      default:
        throw new Error(`not served: ${method}`);
    }
  }
}

const classes = {
  bitcoincash: { single: Wallet, hd: HDWallet },
  bchtest: { single: TestNetWallet, hd: TestNetHDWallet },
};
const networks = {
  bitcoincash: Network.MAINNET,
  bchtest: Network.TESTNET,
};
type DbName = keyof typeof classes;
const walletRows = (Object.keys(classes) as DbName[]).flatMap((dbName) =>
  Object.entries(fixture.expected[dbName]).map(([name, expected]) => ({
    dbName,
    name,
    expected: expected as any,
  })),
);

const hex = (bytes?: Uint8Array) => (bytes ? binToHex(bytes) : null);

describe("data written by mainnet-js 3.1.7", () => {
  const transports = {} as Record<DbName, FixtureTransport>;
  const wallets = new Map<string, BaseWallet>();
  const prevConfig = {
    indexedDb: Config.UseIndexedDBCache,
    storage: BaseWallet.StorageProvider,
    path: Config.DefaultParentDerivationPath,
  };

  beforeAll(async () => {
    await loadIndexedDB(fixture.indexedDB);
    for (const [key, value] of Object.entries(fixture.localStorage)) {
      localStorage.setItem(key, value as string);
    }
    // as Cashonize configures the library (store.ts, walletUtils.ts)
    Config.UseIndexedDBCache = true;
    BaseWallet.StorageProvider = IndexedDBProvider;
    Config.DefaultParentDerivationPath = "m/44'/145'/0'";
    for (const dbName of Object.keys(classes) as DbName[]) {
      const network = networks[dbName];
      transports[dbName] = new FixtureTransport(fixture.chain[network]);
      setGlobalProvider(
        network,
        new ElectrumNetworkProvider(transports[dbName], network),
      );
    }

    for (const { dbName, name, expected } of walletRows) {
      const WalletClass = classes[dbName][expected.kind];
      const wallet = await WalletClass.named(name);
      await wallet.watchPromise;
      wallets.set(`${dbName}/${name}`, wallet);
    }
  });

  afterAll(async () => {
    for (const wallet of wallets.values()) await wallet.stop();
    removeGlobalProvider(Network.MAINNET);
    removeGlobalProvider(Network.TESTNET);
    // node-localstorage keeps its keys on disk, for the next test run too
    for (const key of Object.keys(fixture.localStorage)) {
      localStorage.removeItem(key);
    }
    Config.UseIndexedDBCache = prevConfig.indexedDb;
    BaseWallet.StorageProvider = prevConfig.storage;
    Config.DefaultParentDerivationPath = prevConfig.path;
  });

  test("loading every wallet leaves what 3.1.7 wrote as it is", async () => {
    // past the debounce of the cache writes that loading schedules
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const now = await dumpIndexedDB();

    const schema = (dump: DumpedDatabase[]) =>
      dump.map(({ name, version, stores }) => ({
        name,
        version,
        stores: stores.map(({ name, keyPath, autoIncrement }) => ({
          name,
          keyPath,
          autoIncrement,
        })),
      }));
    expect(schema(now)).toEqual(schema(fixture.indexedDB));
    for (const dbName of [
      "bitcoincash",
      "bchtest",
      "ElectrumNetworkProviderCache",
    ]) {
      expect(records(now, dbName)).toEqual(records(fixture.indexedDB, dbName));
    }

    const before = cacheRecords(fixture.indexedDB);
    const after = cacheRecords(now);
    for (const [key, value] of before) {
      expect(after.get(key), key).toBe(value);
    }
    // the only new records are those of the xpub wallets, which 3.1.7 could not write (its
    // write throws on the missing private keys), in its form and without private keys
    const xpubCacheIds = walletRows
      .filter((row) => row.expected.kind === "hd" && !row.expected.xPriv)
      .map((row) => `walletCache-${row.expected.cacheId}`);
    const added = [...after.keys()].filter((key) => !before.has(key));
    expect(new Set(added)).toEqual(new Set(xpubCacheIds));
    for (const key of added) {
      const record = parse(after.get(key)!);
      expect(Object.keys(record)).toEqual(["walletCache", "indexCache"]);
      for (const [entryKey, entry] of Object.entries<any>(record.walletCache)) {
        expect(entryKey).toBe(
          `${key.slice(12)}-${entry.index}-${entry.change}`,
        );
        expect(entry.privateKey).toBeUndefined();
      }
    }
  });

  test.each(walletRows)(
    "$dbName/$name loads with the type, addresses and keys 3.1.7 derived",
    async ({ dbName, name, expected }) => {
      const wallet = wallets.get(`${dbName}/${name}`)! as any;
      expect(wallet.walletType).toBe(expected.walletType);
      expect(wallet.network).toBe(expected.network);
      expect(wallet.name).toBe(expected.name);
      expect(wallet.toDbString()).toBe(expected.toDbString);
      expect(wallet.toString()).toBe(expected.toString);
      expect(String(await wallet.getBalance())).toBe(expected.balance);
      const utxos = (await wallet.getUtxos()).map(
        (utxo) => `${utxo.txid}:${utxo.vout}`,
      );
      expect(utxos.sort()).toEqual(expected.utxos);

      if (expected.kind === "single") {
        expect(wallet.cashaddr).toBe(expected.cashaddr);
        expect(wallet.tokenaddr).toBe(expected.tokenaddr);
        expect(wallet.getDepositAddress()).toBe(expected.depositAddress);
        expect(wallet.getChangeAddress()).toBe(expected.changeAddress);
        expect(hex(wallet.publicKeyHash)).toBe(expected.publicKeyHash);
        expect(hex(wallet.privateKey)).toBe(expected.privateKey);
        expect(wallet.privateKeyWif ?? null).toBe(expected.privateKeyWif);
        expect(wallet.mnemonic ?? null).toBe(expected.mnemonic);
        if (expected.mnemonic) {
          expect(wallet.derivationPath).toBe(expected.derivationPath);
        }
        return;
      }

      expect(wallet.mnemonic ?? null).toBe(expected.mnemonic);
      if (expected.mnemonic)
        expect(wallet.derivation).toBe(expected.derivation);
      expect(wallet.xPub).toBe(expected.xPub);
      expect(wallet.xPriv ?? null).toBe(expected.xPriv);
      expect(wallet.walletId).toBe(expected.cacheId);
      expect(wallet.indices.get(0)).toBe(expected.depositIndex);
      expect(wallet.indices.get(1)).toBe(expected.changeIndex);
      expect(wallet.getDepositAddress()).toBe(expected.nextDepositAddress);
      expect(wallet.getChangeAddress()).toBe(expected.nextChangeAddress);
      for (const [branch, list] of [
        [0, expected.deposit],
        [1, expected.change],
      ]) {
        list.forEach((want: any, index: number) => {
          const entry = wallet.walletCache.getByIndex(index, branch);
          expect(entry.address).toBe(want.address);
          expect(entry.tokenAddress).toBe(want.tokenAddress);
          expect(hex(entry.privateKey)).toBe(want.privateKey);
          expect(wallet.hasAddress(want.address)).toBe(true);
        });
      }
    },
  );

  test("an HD wallet reuses the 3.1.7 cache: an unchanged address is not fetched again", () => {
    const hdAddresses = new Set<string>();
    for (const value of cacheRecords(fixture.indexedDB).values()) {
      for (const address of Object.keys(parse(value).indexCache)) {
        hdAddresses.add(address);
      }
    }
    const fetched = Object.values(transports)
      .flatMap((transport) => transport.requests)
      .filter((req) => req.method !== "blockchain.address.subscribe")
      .filter((req) => hdAddresses.has(req.params[0]));
    expect(hdAddresses.size).toBeGreaterThan(100);
    expect(fetched).toEqual([]);
  });

  test("a later write keeps 3.1.7's form and every entry 3.1.7 wrote", async () => {
    // the tests above derived more addresses, which a write now adds
    for (const wallet of wallets.values())
      await (wallet.walletCache as WalletCacheI).persist(true);
    const after = cacheRecords(await dumpIndexedDB());

    for (const [key, value] of cacheRecords(fixture.indexedDB)) {
      const before = parse(value);
      const now = parse(after.get(key)!);
      expect(Object.keys(now), key).toEqual(["walletCache", "indexCache"]);
      expect(now.walletCache, key).toMatchObject(before.walletCache);
      expect(now.indexCache, key).toMatchObject(before.indexCache);
      for (const [entryKey, entry] of Object.entries<any>(now.walletCache)) {
        expect(entryKey).toBe(
          `${key.slice(12)}-${entry.index}-${entry.change}`,
        );
        expect(now.indexCache[entry.address]).toEqual({
          index: entry.index,
          change: entry.change,
        });
      }
    }
  });

  test("the electrum caches are read as they are", async () => {
    for (const dbName of Object.keys(classes) as DbName[]) {
      const network = networks[dbName];
      const transport = new FixtureTransport(fixture.chain[network]);
      const provider = new ElectrumNetworkProvider(transport, network);
      await provider.connect();
      const cached = fixture.electrumCache[network];
      const transactions = fixture.chain[network].transactions;

      const raw = await provider.getRawTransactions(cached.rawTransactions);
      for (const txid of cached.rawTransactions) {
        expect(raw.get(txid)).toBe(transactions[txid]);
        expect(await provider.getRawTransaction(txid)).toBe(transactions[txid]);
      }
      const verbose = await provider.getRawTransaction(
        cached.verboseTransaction,
        true,
      );
      expect(verbose.hex).toBe(transactions[cached.verboseTransaction]);
      expect(verbose).not.toHaveProperty("fetchHeight");
      expect(await provider.getHeader(cached.header)).toEqual({
        height: cached.header,
        hex: expect.any(String),
      });
      const headers = await provider.getHeaders(cached.verboseHeaders);
      for (const height of cached.verboseHeaders) {
        expect(headers.get(height)?.height).toBe(height);
        expect((await provider.getHeader(height, true)).height).toBe(height);
      }
      // only the tip subscription, which the verbose transaction's confirmations need
      expect(
        transport.requests.filter(
          (req) => req.method !== "blockchain.headers.subscribe",
        ),
      ).toEqual([]);
    }
  });

  test("the exchange rate cached in localStorage is read as it is", async () => {
    expect(await new ExchangeRateProvider().getRate("usd")).toEqual(
      JSON.parse(fixture.localStorage["rate-usd"]),
    );
  });
});
