import {
  assertSuccess,
  binToHex,
  CashAddressNetworkPrefix,
  CashAddressType,
  decodeCashAddressFormatWithoutPrefix,
  decodePrivateKeyWif,
  deriveHdPath,
  deriveHdPathRelative,
  deriveHdPrivateNodeFromSeed,
  deriveSeedFromBip39Mnemonic,
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
import { NetworkType, prefixFromNetworkMap } from "../enum.js";
import { TxI, Utxo } from "../interface.js";
import { toCashaddr } from "../util/deriveCashaddr.js";
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

/// The id a wallet's cache record is keyed by: a hash of what the wallet derives its addresses
/// from (an HD wallet's seed or extended key, a single-address wallet's cashaddr) and its network
export function deriveWalletCacheId(source: string, network: string): string {
  return binToHex(sha256.hash(utf8ToBin(`${source}-${network}`)));
}

function p2pkhCashaddr(privateKey: Uint8Array, network: string): string {
  const publicKey = assertSuccess(
    secp256k1.derivePublicKeyCompressed(privateKey),
  );
  return encodeCashAddress({
    prefix: prefixFromNetworkMap[network as NetworkType],
    type: "p2pkh",
    payload: hash160(publicKey),
  }).address;
}

/// The cache id of the wallet a stored wallet id (`toDbString()`, a database row's `wallet`)
/// stands for, derived the way the wallet classes do without constructing one
export function walletCacheIdFromWalletId(walletId: string): string {
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
    case "seed": {
      const mnemonic = arg1.trim().toLowerCase();
      const path = arg2 || Config.DefaultParentDerivationPath + "/0/0";
      const rootNode = deriveHdPrivateNodeFromSeed(
        deriveSeedFromBip39Mnemonic(mnemonic),
        { assumeValidity: true, throwErrors: true },
      );
      const { privateKey } = deriveHdPath(rootNode, path);
      return deriveWalletCacheId(p2pkhCashaddr(privateKey, network), network);
    }
    case "privkey":
      return deriveWalletCacheId(
        p2pkhCashaddr(hexToBin(arg1), network),
        network,
      );
    case "wif": {
      const { privateKey } = assertSuccess(decodePrivateKeyWif(arg1));
      return deriveWalletCacheId(p2pkhCashaddr(privateKey, network), network);
    }
    case "watch": {
      let address = arg2 ? `${arg1}:${arg2}` : arg1;
      if (!address.includes(":")) {
        const { prefix } = assertSuccess(
          decodeCashAddressFormatWithoutPrefix(address),
        );
        address = `${prefix}:${address}`;
      }
      return deriveWalletCacheId(toCashaddr(address), network);
    }
    default:
      throw new Error(`Unsupported wallet type '${walletType}'`);
  }
}

/**
 * Removes the cache record of a wallet (its derived addresses with their private keys, status,
 * utxos and history) from the cache storage that `Config` selects. Use it when deleting a wallet.
 * A wallet still running writes its record again.
 *
 * @param walletId the wallet's stored id, as `toDbString()` returns it and a database row holds it
 */
export async function purgeWalletCache(walletId: string): Promise<void> {
  const cacheId = walletCacheIdFromWalletId(walletId);
  const storage = getStorage();
  if (!storage) return;
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
  const keep = new Set(
    keepWalletIds.map(
      (walletId) => CACHE_KEY_PREFIX + walletCacheIdFromWalletId(walletId),
    ),
  );
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

/// Cache for single-address wallets (WatchWallet, Wif)
export class SingleAddressWalletCache implements WalletCacheI {
  private entry: WalletCacheEntry;
  private _storage: CacheProvider | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public walletId: string,
    address: string,
    tokenAddress: string,
    public writeTimeout: number = 2000,
  ) {
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

  public async init() {
    this._storage = getStorage();
    await this._storage?.init();
    const data = await this._storage?.getItem(CACHE_KEY_PREFIX + this.walletId);
    if (data) {
      try {
        const parsed = parse(data);
        // Restore persisted fields, keep address identity from constructor
        const addr = this.entry.address;
        const tokenAddr = this.entry.tokenAddress;
        Object.assign(this.entry, parsed, {
          address: addr,
          tokenAddress: tokenAddr,
        });
      } catch {
        // ignore
      }
    }
  }

  public async persist(immediate = false) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (immediate) {
      this.debounceTimer = undefined;
      await this._storage?.setItem(
        CACHE_KEY_PREFIX + this.walletId,
        stringify(this.entry),
      );
    } else {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        // a failed write is redone by the next one, which writes the whole entry
        this._storage
          ?.setItem(CACHE_KEY_PREFIX + this.walletId, stringify(this.entry))
          .catch(() => {});
      }, this.writeTimeout);
    }
  }

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
    void this.persist(); // debounced, only schedules the write
  }
}

export class HDWalletCache implements WalletCacheI {
  private _storage: CacheProvider | undefined;
  private walletCache: Record<string, WalletCacheEntry> = {};
  // Address -> relative derivation path. Used to find the cache key for a
  // given address; independent of any branch / change-axis semantics.
  private pathCache: Record<string, string> = {};
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
    let migrated = false;
    if (data) {
      try {
        const parsed = parse(data);
        this.pathCache = parsed.pathCache || {};
        // Keep only entries reachable through pathCache: the pre-next.14 format keyed them
        // `${walletId}-${index}-${change}` (with an indexCache), private keys included, and
        // would otherwise be carried forward on every write without ever being read
        const stored: Record<string, WalletCacheEntry> =
          parsed.walletCache || {};
        let dropped = false;
        for (const [key, entry] of Object.entries(stored)) {
          const path = this.pathCache[entry?.address];
          if (path !== undefined && key === `${this.walletId}-${path}`) {
            this.walletCache[key] = entry;
          } else {
            dropped = true;
          }
        }
        migrated = dropped || parsed.indexCache !== undefined;
      } catch {
        // ignore
      }
    }
    if (migrated) await this.persist(true);
  }

  public async persist(immediate = false) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const write = () =>
      this._storage?.setItem(
        CACHE_KEY_PREFIX + this.walletId,
        stringify({
          walletCache: this.walletCache,
          pathCache: this.pathCache,
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

  /**
   * Derive (or fetch from cache) the address at the given relative derivation
   * path. The cache is policy-free -- the caller decides what path to ask
   * for (e.g. a depth-4 wallet with a bare-index chain, or arbitrary integer
   * branches).
   */
  public getByPath(relativePath: string): WalletCacheEntry {
    const id = `${this.walletId}-${relativePath}`;
    if (!this.walletCache[id]) {
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

      this.walletCache[id] = {
        address,
        tokenAddress,
        privateKey: privateKey,
        publicKey,
        publicKeyHash,
        status: null,
        utxos: [],
        rawHistory: [],
        lastConfirmedHeight: 0,
      };

      this.pathCache[address] = relativePath;

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
    const path = this.pathCache[address];
    if (path === undefined) return undefined;
    return this.walletCache[`${this.walletId}-${path}`];
  }

  public setStatusAndUtxos(
    address: string,
    status: string | null,
    utxos: Utxo[],
    rawHistory: TxI[],
    lastConfirmedHeight: number,
  ) {
    const path = this.pathCache[address];
    if (path === undefined) {
      return;
    }
    const key = `${this.walletId}-${path}`;
    if (!this.walletCache[key]) {
      return;
    }
    this.walletCache[key].status = status;
    this.walletCache[key].utxos = utxos;
    this.walletCache[key].rawHistory = rawHistory;
    this.walletCache[key].lastConfirmedHeight = lastConfirmedHeight;

    void this.persist(); // debounced, only schedules the write
  }
}
