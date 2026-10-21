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
import { walletIdKind } from "../util/walletIdError.js";
import { InvalidWalletIdError } from "../wallet/errors.js";
import { IndexedDbCache } from "./IndexedDbCache.js";
import { CacheProvider } from "./interface.js";

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
  /** @internal Loads the stored record; the wallet calls it as it is set up */
  init(): Promise<void>;
  persist(immediate?: boolean): Promise<void>;
  /** @internal Writes now what a debounced persist() has yet to write, if anything */
  flush(): Promise<void>;
  get(address: string): WalletCacheEntry | undefined;
  /**
   * Conventional (branch × addressIndex) lookup using the standard
   * `${branch}/${index}` derivation path.
   */
  getByIndex(addressIndex: number, branch: number): WalletCacheEntry;
  /**
   * @internal
   * Derive (or fetch from cache) the address at the given relative derivation
   * path. The cache is policy-free -- the caller decides what path to ask
   * for (e.g. arbitrary integer branches).
   */
  getByPath(relativePath: string): WalletCacheEntry;
  /** @internal The wallet's status watch records what it fetched for an address */
  setStatusAndUtxos(
    address: string,
    status: string | null,
    utxos: Utxo[],
    rawHistory: TxI[],
    lastConfirmedHeight: number,
  ): void;
}

function getStorage(): CacheProvider | undefined {
  if (Config.UseIndexedDBCache) return new IndexedDbCache("WalletCache");
  return undefined;
}

const CACHE_KEY_PREFIX = "walletCache-";

// Per cache id, the purges running and the purges completed: no HDWalletCache of the id writes
// while one runs, and one made before a purge completed, or while it ran, writes no more
const purgesRunning = new Map<string, number>();
const purgesDone = new Map<string, number>();

/// The id an HD wallet's cache record is keyed by: a hash of what the wallet derives its addresses
/// from (its seed and derivation path, or its extended key) and its network
export function deriveWalletCacheId(source: string, network: string): string {
  return binToHex(sha256.hash(utf8ToBin(`${source}-${network}`)));
}

/// The cache id of the HD wallet a stored wallet id (`toDbString()`, a database row's `wallet`)
/// stands for, derived the way HDWallet does without constructing one; undefined for a
/// single-address wallet, which keeps no cache record. Throws InvalidWalletIdError for an id no
/// wallet class loads
export function walletCacheIdFromWalletId(
  walletId: string,
): string | undefined {
  const [walletType, network, arg1, arg2] = walletId.split(":");
  const kind = walletIdKind(walletType);
  if (!network || !(network in prefixFromNetworkMap)) {
    throw new InvalidWalletIdError("Not a stored wallet id", {
      kind,
      reason: "network",
    });
  }
  if (!arg1) {
    throw new InvalidWalletIdError("Not a stored wallet id", {
      kind,
      reason: "missing-value",
    });
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
      // a known kind only: the type slot of a malformed id may hold the key
      throw new InvalidWalletIdError(
        kind ? `Unsupported wallet type '${kind}'` : "Unsupported wallet type",
        { kind, reason: "kind" },
      );
  }
}

/**
 * Removes the cache record of an HD wallet (its derived addresses with their private keys, status,
 * utxos and history) from the cache storage that `Config` selects; a single-address wallet has
 * none. Use it when deleting a wallet, which {@link deleteNamedWallet} does. Once it resolves,
 * wallets of that id made before it resolved, running or stopped, write the record no more: from
 * then on they keep their cache in memory only. If it rejects, the record may still be there, and
 * those wallets go on writing it.
 *
 * That holds in this JavaScript process only: a wallet of that id open in another browser tab
 * still writes its record back. {@link pruneWalletCaches} at a later start removes it.
 *
 * @param walletId the wallet's stored id, as `toDbString()` returns it and a database row holds it
 * @param beforeDone runs once the record is removed, before the purge counts as done, so that a
 * wallet of the id opened meanwhile writes no record either (deleteNamedWallet's row removal)
 */
export async function purgeWalletCache(
  walletId: string,
  beforeDone?: () => Promise<void>,
): Promise<void> {
  const cacheId = walletCacheIdFromWalletId(walletId);
  if (cacheId === undefined) {
    await beforeDone?.();
    return;
  }
  const storage = getStorage();
  purgesRunning.set(cacheId, (purgesRunning.get(cacheId) ?? 0) + 1);
  try {
    if (storage) {
      // a write already started lands before the removal: IndexedDB runs a store's readwrite
      // transactions in the order they were made
      await storage.init();
      try {
        await storage.removeItem(CACHE_KEY_PREFIX + cacheId);
      } finally {
        await storage.close();
      }
    }
    await beforeDone?.();
    purgesDone.set(cacheId, (purgesDone.get(cacheId) ?? 0) + 1);
  } finally {
    const running = purgesRunning.get(cacheId)! - 1;
    if (running === 0) purgesRunning.delete(cacheId);
    else purgesRunning.set(cacheId, running);
  }
}

/**
 * Removes the cache record of every wallet but the given ones from the cache storage that
 * `Config` selects, e.g. records that wallets deleted without {@link purgeWalletCache} left
 * behind. Pass the stored id of every wallet that is kept, from all databases.
 *
 * An id that cannot be read is skipped and keeps nothing: no wallet class loads it, so no
 * record is its own. The others are pruned as usual.
 *
 * @param keepWalletIds the stored ids of the wallets whose records stay
 * @returns the positions in `keepWalletIds` of the ids that could not be read, empty when
 * every one was read
 */
export async function pruneWalletCaches(
  keepWalletIds: string[],
): Promise<number[]> {
  const keep = new Set<string>();
  const unreadable: number[] = [];
  keepWalletIds.forEach((walletId, position) => {
    let cacheId: string | undefined;
    try {
      cacheId = walletCacheIdFromWalletId(walletId);
    } catch (error) {
      if (!(error instanceof InvalidWalletIdError)) throw error;
      unreadable.push(position);
      return;
    }
    if (cacheId !== undefined) keep.add(CACHE_KEY_PREFIX + cacheId);
  });
  const storage = getStorage();
  if (!storage) return unreadable;
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
  return unreadable;
}

// How far a discovery started from the cache subscribes in its first round, so that a damaged
// record cannot make it subscribe an unbounded range; a wallet used further is found by discovery
// extending its window from there.
const USED_LENGTH_LIMIT = 2000;

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

  public async flush() {}

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
// the paths `0/index` and `1/index` have a place in it; others (more branches) are cached in memory
// only.
const STORED_PATH = /^([01])\/(\d+)$/;

export class HDWalletCache implements WalletCacheI {
  private _storage: CacheProvider | undefined;
  private walletCache: Record<string, WalletCacheEntry> = {};
  private indexCache: Record<string, { index: number; change: boolean }> = {};
  private memoryCache: Record<string, WalletCacheEntry> = {};
  // address -> relative path of the entries in memoryCache
  private memoryPaths: Record<string, string> = {};
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // purges of walletId completed before this cache was made; a later one stops its writes
  private readonly purgesDoneAtStart: number;

  constructor(
    public readonly walletId: string,
    public hdNode: HdPublicNodeValid | HdPrivateNodeValid,
    public networkPrefix: string,
    public writeTimeout: number = 2000,
  ) {
    if (!this.hdNode) {
      throw new Error("HDNode is undefined");
    }
    this.purgesDoneAtStart = purgesDone.get(walletId) ?? 0;
  }

  public async init() {
    // a watch-only wallet's cache stays in memory: 3.1.7 never wrote one, its write threw on the
    // missing private keys, so a rollback would leave it behind
    if (!("privateKey" in this.hdNode)) return;
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
    if (immediate) {
      this.debounceTimer = undefined;
      await this.write();
    } else {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        // a failed write is redone by the next one, which writes the whole cache
        this.write().catch(() => {});
      }, this.writeTimeout);
    }
  }

  public async flush() {
    if (this.debounceTimer) await this.persist(true);
  }

  private write(): Promise<void> {
    const stopped =
      purgesRunning.has(this.walletId) ||
      (purgesDone.get(this.walletId) ?? 0) !== this.purgesDoneAtStart;
    if (!this._storage || stopped) return Promise.resolve();
    return this._storage.setItem(
      CACHE_KEY_PREFIX + this.walletId,
      stringify({
        walletCache: this.walletCache,
        indexCache: this.indexCache,
      }),
    );
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
   * The index after the highest address of branch 0 or 1 with a stored status: how far the wallet
   * was used when the cache was last written, read from the stored entries alone, and at most
   * USED_LENGTH_LIMIT. 0 for other branches, which are not stored.
   */
  public usedLength(branch: number): number {
    if (branch !== 0 && branch !== 1) return 0;
    const change = branch === 1;
    let length = 0;
    for (const entry of Object.values(this.walletCache)) {
      if (entry.change !== change || typeof entry.status !== "string") continue;
      if (entry.index !== undefined && entry.index + 1 > length)
        length = entry.index + 1;
    }
    return Math.min(length, USED_LENGTH_LIMIT);
  }

  /**
   * Derive (or fetch from cache) the address at the given relative derivation
   * path. The cache is policy-free -- the caller decides what path to ask
   * for (e.g. arbitrary integer branches).
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
