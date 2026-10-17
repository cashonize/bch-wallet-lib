import {
  assertSuccess,
  binToHex,
  CashAddressNetworkPrefix,
  CashAddressType,
  deriveHdPathRelative,
  encodeCashAddress,
  HdPrivateNodeValid,
  HdPublicNodeValid,
  hash160,
  hexToBin,
  secp256k1,
  sha256,
  utf8ToBin,
} from "@bitauth/libauth";
import { Config } from "../config.js";
import { prefixFromNetworkMap } from "../enum.js";
import { TxI, Utxo } from "../interface.js";
import { IndexedDbCache } from "./IndexedDbCache.js";
import { CacheProvider } from "./interface.js";
import { MemoryCache } from "./MemoryCache.js";
import { WebStorageCache } from "./WebStorageCache.js";

export const stringify = (_: any) =>
  JSON.stringify(_, (key, value) => {
    if (key.includes("Key")) {
      // Watching-only entries have `privateKey === undefined`; preserve that
      // by emitting null rather than calling binToHex on undefined.
      return value === undefined ? null : binToHex(value);
    }
    return typeof value === "bigint" ? value.toString() + "n" : value;
  });
export const parse = (data: string) =>
  JSON.parse(data, (key, value) => {
    if (key.includes("Key")) {
      if (value === null) return undefined;
      if (typeof value === "string") return hexToBin(value);
    }

    if (typeof value === "string" && /^\d+n$/.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    return value;
  });

export interface WalletCacheEntry {
  address: string;
  tokenAddress: string;
  privateKey: Uint8Array | undefined;
  publicKey: Uint8Array;
  publicKeyHash: Uint8Array;
  // An HD entry's place in mainnet-js 3.1.7's stored form: index on branch 0 (false) or 1 (true)
  index?: number;
  change?: boolean;
  status: string | null;
  utxos: Utxo[];
  rawHistory: TxI[];
  // Top block height of confirmed history items, used for incremental fetching
  lastConfirmedHeight: number;
}

// Minimal interface for use in transaction signing
export interface WalletCache {
  get(address: string): { privateKey: Uint8Array | undefined } | undefined;
}

// Full interface for wallet cache management
export interface WalletCacheI extends WalletCache {
  init(): Promise<void>;
  persist(immediate?: boolean): Promise<void>;
  get(address: string): WalletCacheEntry | undefined;
  /**
   * Conventional (branch × addressIndex) lookup using the standard
   * `${branch}/${index}` derivation path.
   */
  getByIndex(addressIndex: number, branch: number): WalletCacheEntry;
  /**
   * Derive (or fetch from cache) the address at the given relative derivation
   * path. The cache is policy-free -- the caller decides what path to ask
   * for (e.g. a depth-4 wallet with a bare-index chain, or arbitrary integer
   * branches).
   */
  getByPath(relativePath: string): WalletCacheEntry;
  setStatusAndUtxos(
    address: string,
    status: string | null,
    utxos: Utxo[],
    rawHistory: TxI[],
    lastConfirmedHeight: number,
  ): void;
}

function getStorage(): CacheProvider | undefined {
  if (Config.UseMemoryCache) return new MemoryCache();
  if (Config.UseLocalStorageCache) return new WebStorageCache();
  if (Config.UseIndexedDBCache) return new IndexedDbCache("WalletCache");
  return undefined;
}

const CACHE_KEY_PREFIX = "walletCache-";

/// The id an HD wallet's cache record is keyed by: a hash of what the wallet derives its addresses
/// from (its seed and derivation path, or its extended key) and its network
export function deriveWalletCacheId(source: string, network: string): string {
  return binToHex(sha256.hash(utf8ToBin(`${source}-${network}`)));
}

/// The cache id of the HD wallet a stored wallet id (`toDbString()`, a database row's `wallet`)
/// stands for, derived the way HDWallet does without constructing one; undefined for a
/// single-address wallet, which keeps no cache record
export function walletCacheIdFromWalletId(
  walletId: string,
): string | undefined {
  const [walletType, network, arg1, arg2] = walletId.split(":");
  if (!network || !(network in prefixFromNetworkMap) || !arg1) {
    throw new Error("Not a stored wallet id");
  }

  switch (walletType) {
    case "hd": {
      // HDWallet hashes an extended key on its own, a mnemonic (the only form with spaces) with
      // its derivation path
      if (!arg1.includes(" ")) {
        return deriveWalletCacheId(arg1, network);
      }
      const derivation = arg2 || Config.DefaultParentDerivationPath;
      return deriveWalletCacheId(arg1 + derivation, network);
    }
    case "seed":
    case "privkey":
    case "wif":
    case "watch":
      return undefined;
    default:
      throw new Error(`Unsupported wallet type '${walletType}'`);
  }
}

/**
 * Removes the cache record of an HD wallet (its derived addresses with their private keys, status,
 * utxos and history) from the cache storage that `Config` selects; a single-address wallet has
 * none. Use it when deleting a wallet, which {@link deleteNamedWallet} does. A wallet still running
 * writes its record again.
 *
 * @param walletId the wallet's stored id, as `toDbString()` returns it and a database row holds it
 */
export async function purgeWalletCache(walletId: string): Promise<void> {
  const cacheId = walletCacheIdFromWalletId(walletId);
  const storage = getStorage();
  if (cacheId === undefined || !storage) return;
  await storage.init();
  try {
    await storage.removeItem(CACHE_KEY_PREFIX + cacheId);
  } finally {
    await storage.close();
  }
}

/**
 * Removes the cache record of every wallet but the given ones from the cache storage that
 * `Config` selects, e.g. records that wallets deleted without {@link purgeWalletCache} left
 * behind. Pass the stored id of every wallet that is kept, from all databases.
 *
 * @param keepWalletIds the stored ids of the wallets whose records stay
 */
export async function pruneWalletCaches(
  keepWalletIds: string[],
): Promise<void> {
  // derived before anything is removed, so an id that cannot be read removes nothing
  const keep = new Set<string>();
  for (const walletId of keepWalletIds) {
    const cacheId = walletCacheIdFromWalletId(walletId);
    if (cacheId !== undefined) keep.add(CACHE_KEY_PREFIX + cacheId);
  }
  const storage = getStorage();
  if (!storage) return;
  await storage.init();
  try {
    for (const key of await storage.keys()) {
      if (key.startsWith(CACHE_KEY_PREFIX) && !keep.has(key)) {
        await storage.removeItem(key);
      }
    }
  } finally {
    await storage.close();
  }
}

/// Cache for single-address wallets (WatchWallet, Wif), in memory only as in mainnet-js 3.1.7: the
/// wallet's own database record already holds its key, and a cache record would be a second copy
export class SingleAddressWalletCache implements WalletCacheI {
  private entry: WalletCacheEntry;

  constructor(address: string, tokenAddress: string) {
    this.entry = {
      address,
      tokenAddress,
      privateKey: undefined,
      publicKey: new Uint8Array(),
      publicKeyHash: new Uint8Array(),
      status: null,
      utxos: [],
      rawHistory: [],
      lastConfirmedHeight: 0,
    };
  }

  public async init() {}

  public async persist() {}

  public get(address: string) {
    return address === this.entry.address ? this.entry : undefined;
  }

  public getByIndex(_index: number, _branch: number) {
    return this.entry;
  }

  public getByPath(_path: string) {
    return this.entry;
  }

  public setStatusAndUtxos(
    address: string,
    status: string | null,
    utxos: Utxo[],
    rawHistory: TxI[],
    lastConfirmedHeight: number,
  ) {
    if (address !== this.entry.address) return;
    this.entry.status = status;
    this.entry.utxos = utxos;
    this.entry.rawHistory = rawHistory;
    this.entry.lastConfirmedHeight = lastConfirmedHeight;
  }
}

// HD cache records keep mainnet-js 3.1.7's form, which Cashonize users' storage holds and a rollback
// reads: entries keyed `${walletId}-${index}-${change}` and an address -> {index, change} map. Only
// the paths `0/index` and `1/index` have a place in it; others (more branches, a depth-4 node's bare
// index) are cached in memory only.
const STORED_PATH = /^([01])\/(\d+)$/;

export class HDWalletCache implements WalletCacheI {
  private _storage: CacheProvider | undefined;
  private walletCache: Record<string, WalletCacheEntry> = {};
  private indexCache: Record<string, { index: number; change: boolean }> = {};
  private memoryCache: Record<string, WalletCacheEntry> = {};
  // address -> relative path of the entries in memoryCache
  private memoryPaths: Record<string, string> = {};
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public walletId: string,
    public hdNode: HdPublicNodeValid | HdPrivateNodeValid,
    public networkPrefix: string,
    public writeTimeout: number = 2000,
  ) {
    if (!this.hdNode) {
      throw new Error("HDNode is undefined");
    }
  }

  public async init() {
    this._storage = getStorage();
    await this._storage?.init();
    const data = await this._storage?.getItem(CACHE_KEY_PREFIX + this.walletId);
    if (data) {
      try {
        const parsed = parse(data);
        // entries in another form (next.14 keyed them by path) are not read, and so not written back
        const prefix = `${this.walletId}-`;
        for (const [key, entry] of Object.entries<WalletCacheEntry>(
          parsed.walletCache || {},
        )) {
          const place = key.slice(prefix.length);
          if (key.startsWith(prefix) && /^\d+-(true|false)$/.test(place)) {
            this.walletCache[key] = entry;
          }
        }
        this.indexCache = parsed.indexCache || {};
      } catch {
        // ignore
      }
    }
  }

  public async persist(immediate = false) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const write = () =>
      this._storage?.setItem(
        CACHE_KEY_PREFIX + this.walletId,
        stringify({
          walletCache: this.walletCache,
          indexCache: this.indexCache,
        }),
      );
    if (immediate) {
      this.debounceTimer = undefined;
      await write();
    } else {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        // a failed write is redone by the next one, which writes the whole cache
        write()?.catch(() => {});
      }, this.writeTimeout);
    }
  }

  private derive(
    relativePath: string,
    place?: { index: number; change: boolean },
  ): WalletCacheEntry {
    const node = deriveHdPathRelative(this.hdNode, relativePath);

    const privateKey = "privateKey" in node ? node.privateKey : undefined;
    const publicKey =
      "publicKey" in node
        ? node.publicKey
        : assertSuccess(secp256k1.derivePublicKeyUncompressed(privateKey!));
    const publicKeyCompressed = assertSuccess(
      secp256k1.compressPublicKey(publicKey),
    );
    const publicKeyHash = hash160(publicKeyCompressed);

    const address = encodeCashAddress({
      throwErrors: true,
      prefix: this.networkPrefix as CashAddressNetworkPrefix,
      type: CashAddressType.p2pkh,
      payload: publicKeyHash,
    }).address;

    const tokenAddress = encodeCashAddress({
      throwErrors: true,
      prefix: this.networkPrefix as CashAddressNetworkPrefix,
      type: CashAddressType.p2pkhWithTokens,
      payload: publicKeyHash,
    }).address;

    // in 3.1.7's field order
    return {
      address,
      tokenAddress,
      privateKey,
      publicKey,
      publicKeyHash,
      ...place,
      status: null,
      utxos: [],
      rawHistory: [],
      lastConfirmedHeight: 0,
    };
  }

  /**
   * Derive (or fetch from cache) the address at the given relative derivation
   * path. The cache is policy-free -- the caller decides what path to ask
   * for (e.g. a depth-4 wallet with a bare-index chain, or arbitrary integer
   * branches).
   */
  public getByPath(relativePath: string): WalletCacheEntry {
    const match = STORED_PATH.exec(relativePath);
    if (!match) {
      if (!this.memoryCache[relativePath]) {
        const entry = this.derive(relativePath);
        this.memoryCache[relativePath] = entry;
        this.memoryPaths[entry.address] = relativePath;
      }
      return this.memoryCache[relativePath];
    }

    const index = Number(match[2]);
    const change = match[1] === "1";
    const id = `${this.walletId}-${index}-${change}`;
    if (!this.walletCache[id]) {
      const entry = this.derive(relativePath, { index, change });
      this.walletCache[id] = entry;
      this.indexCache[entry.address] = { index, change };

      void this.persist(); // debounced, only schedules the write
    }

    return this.walletCache[id];
  }

  /**
   * Conventional (branch × addressIndex) lookup. Thin wrapper around
   * {@link getByPath} that uses the standard `${branch}/${index}` convention.
   */
  public getByIndex(addressIndex: number, branch: number): WalletCacheEntry {
    return this.getByPath(`${branch}/${addressIndex}`);
  }

  public get(address: string) {
    const place = this.indexCache[address];
    if (place) {
      const entry = this.getByPath(`${place.change ? 1 : 0}/${place.index}`);
      // only the entry of that address, whatever the stored map says
      if (entry.address === address) return entry;
    }
    const path = this.memoryPaths[address];
    if (path === undefined) return undefined;
    return this.memoryCache[path];
  }

  public setStatusAndUtxos(
    address: string,
    status: string | null,
    utxos: Utxo[],
    rawHistory: TxI[],
    lastConfirmedHeight: number,
  ) {
    const entry = this.get(address);
    if (!entry) {
      return;
    }
    entry.status = status;
    entry.utxos = utxos;
    entry.rawHistory = rawHistory;
    entry.lastConfirmedHeight = lastConfirmedHeight;

    void this.persist(); // debounced, only schedules the write
  }
}
