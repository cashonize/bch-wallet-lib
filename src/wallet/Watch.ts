import {
  assertSuccess,
  binToHex,
  CashAddressNetworkPrefix,
  decodeCashAddress,
  decodeCashAddressFormatWithoutPrefix,
  encodeCashAddress,
  hash160,
  secp256k1,
} from "@bitauth/libauth";
import {
  SingleAddressWalletCache,
  WalletCacheEntry,
  WalletCacheI,
} from "../cache/walletCache.js";
import {
  NetworkType,
  networkPrefixMap,
  prefixFromNetworkMap,
} from "../enum.js";
import { getHistory } from "../history/getHistory.js";
import { TransactionHistoryItem } from "../history/interface.js";
import { TxI, Utxo } from "../interface.js";
import { toCashaddr, toTokenaddr } from "../util/deriveCashaddr.js";
import { derivePrefix } from "../util/derivePublicKeyHash.js";
import { sumUtxoValue } from "../util/sumUtxoValue.js";
import { BaseWallet } from "./Base.js";
import { WalletTypeEnum } from "./enum.js";
import { CancelFn } from "./interface.js";
import { networkPrefixError } from "../util/networkPrefixError.js";
import { toError } from "../util/toError.js";
import { runCallback } from "../util/watch.js";

export interface WatchWalletOptions {
  name?: string;
  publicKey?: Uint8Array;
  publicKeyCompressed?: Uint8Array;
  publicKeyHash?: Uint8Array;
  address?: string;
}

/**
 * Class to manage a mainnet watch wallet.
 */
export class WatchWallet extends BaseWallet {
  declare readonly walletCache: WalletCacheI;
  readonly publicKeyCompressed?: Uint8Array;
  readonly publicKey?: Uint8Array;
  readonly publicKeyHash!: Uint8Array;
  readonly cashaddr!: string;
  readonly tokenaddr!: string;

  static networkPrefix = CashAddressNetworkPrefix.mainnet;
  static walletType = WalletTypeEnum.Watch;

  // Subscription-first infrastructure: single subscription shared by all watchers
  private watchCallbacks: Array<
    (status: string | null, address: string) => unknown
  > = [];
  private baseCancelFn?: CancelFn;
  /** Settles when the latest status watch is in place or has failed, and never rejects. */
  watchPromise?: Promise<void>;
  updatePromise?: Promise<void>;
  // the latest status watch, which rejects if it failed; reads await it through watched()
  private watch: Promise<void> = Promise.resolve();
  private watchFailed = false;
  private stopped = false;

  // Live state - updated by subscription notifications
  private status: string | null = null;
  private utxos: Utxo[] = [];
  private rawHistory: TxI[] = [];
  private lastConfirmedHeight: number = 0;

  constructor(
    name = "",
    network = NetworkType.Mainnet,
    walletType = WalletTypeEnum.Watch,
  ) {
    super(network);

    this.name = name;
    // @ts-ignore
    this.walletType = walletType;
  }

  /// Initialize the watch-only wallet given the options - publicKey variations
  /// This internal method is called by the various static constructors
  protected async initialize({
    name = "",
    publicKey,
    publicKeyCompressed,
    publicKeyHash,
    address,
  }: WatchWalletOptions = {}): Promise<this> {
    if (publicKey?.length) {
      // @ts-ignore
      this.publicKey = publicKey;

      if (!publicKeyCompressed) {
        publicKeyCompressed = assertSuccess(
          secp256k1.compressPublicKey(publicKey),
        );
      }
    }

    if (publicKeyCompressed?.length) {
      // @ts-ignore
      this.publicKeyCompressed = publicKeyCompressed;

      if (!publicKey) {
        publicKey = assertSuccess(
          secp256k1.uncompressPublicKey(publicKeyCompressed),
        );
        // @ts-ignore
        this.publicKey = publicKey;
      }

      publicKeyHash = hash160(publicKeyCompressed);
    }

    if (publicKeyHash?.length) {
      // @ts-ignore
      this.publicKeyHash = publicKeyHash;

      address = encodeCashAddress({
        prefix: prefixFromNetworkMap[this.network],
        type: "p2pkh",
        payload: publicKeyHash,
      }).address;
    }

    if (address?.length) {
      // derive prefix if not provided
      if (!address.includes(":")) {
        const decoded = assertSuccess(
          decodeCashAddressFormatWithoutPrefix(address),
        );
        address = `${decoded.prefix}:${address}`;
      }

      const decoded = assertSuccess(decodeCashAddress(address));

      if (networkPrefixMap[decoded.prefix] !== this.network) {
        throw Error(
          `a ${decoded.prefix} address cannot be watched from a ${this.network} Wallet`,
        );
      }

      if (!this.publicKeyHash?.length) {
        if (decoded.type.includes("p2pkh")) {
          // @ts-ignore
          this.publicKeyHash = decoded.payload;
        }
      }

      // @ts-ignore
      this.cashaddr = toCashaddr(address);
      // @ts-ignore
      this.tokenaddr = toTokenaddr(address);
    }

    if (!this.cashaddr?.length || !this.tokenaddr?.length) {
      throw Error("Could not initialize wallet - insufficient parameters");
    }

    this.name = name;

    // the cache is in memory only, so this starts from an unknown status
    await this.initWalletCache();
    const cached = this.getCacheEntry();
    this.status = cached.status;
    this.utxos = cached.utxos;
    this.rawHistory = cached.rawHistory;
    this.lastConfirmedHeight = cached.lastConfirmedHeight;

    // Start subscription immediately (subscription-first approach)
    void this.startWatch();

    return this;
  }

  protected async initWalletCache(): Promise<void> {
    const cache = new SingleAddressWalletCache(this.cashaddr, this.tokenaddr);
    const wallet = this as any;
    if (wallet.privateKey) {
      cache.get(this.cashaddr)!.privateKey = wallet.privateKey;
    }
    // @ts-ignore
    this.walletCache = cache;
  }

  protected getCacheEntry(): WalletCacheEntry {
    return this.walletCache.get(this.cashaddr)!;
  }

  /// Make the status watch once the one in progress has ended. If it fails, the next read makes it
  /// again
  private startWatch(): Promise<void> {
    this.watchFailed = false;
    const run = this.watch.catch(() => {}).then(() => this.makeWatchPromise());
    this.watch = run;
    this.watchPromise = run.then(
      () => {},
      () => {
        if (this.watch === run) this.watchFailed = true;
      },
    );
    return run;
  }

  /// Wait for the status watch, making it again first if the last one failed; rejects with the
  /// error of a watch that fails, rather than reading a cached or empty state
  private watched(): Promise<void> {
    if (this.watchFailed && !this.stopped) void this.startWatch();
    return this.watch;
  }

  /// Subscribe to the single address for status change notifications. Settles once the first
  /// status is handled; a subscription or first fetch that fails ends the subscription and rejects
  private makeWatchPromise(): Promise<void> {
    const addr = this.cashaddr;
    let watched = false;
    let failed = false;
    let cancel: CancelFn | undefined;

    return new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        failed = true;
        cancel?.().catch(() => {});
        reject(toError(error));
      };

      const callback = ([address, status]: [string, string | null]) => {
        if (address !== addr || failed) return;
        this.update(status).then(
          () => {
            watched = true;
            resolve();
          },
          (error: unknown) => {
            // a later fetch that fails leaves the old status, so the next notification fetches again
            if (!watched) fail(error);
          },
        );
      };

      this.subscribe((provider) =>
        provider.subscribeToAddress(addr, callback),
      ).then((made) => {
        if (failed) {
          made().catch(() => {});
        } else {
          cancel = made;
          this.baseCancelFn = made;
        }
      }, fail);
    });
  }

  private async update(status: string | null): Promise<void> {
    if (status !== null && status !== this.status) {
      const update = this.fetchData(status);
      this.updatePromise = update.catch(() => {});
      await update;
    }
    this.status = status;
    this.notifyWatchCallbacks(status, this.cashaddr);
  }

  private async fetchData(status: string | null): Promise<void> {
    const addr = this.cashaddr;
    const fromHeight = this.lastConfirmedHeight;

    const [utxos, newHistory] = await Promise.all([
      this.provider.getUtxos(addr),
      this.provider.getHistory(addr, fromHeight),
    ]);

    // Merge: keep confirmed items below fromHeight, add new items
    const confirmedFromHistory = this.rawHistory.filter(
      (tx) => tx.height > 0 && tx.height < fromHeight,
    );
    const seen = new Set(confirmedFromHistory.map((tx) => tx.tx_hash));
    const merged = [...confirmedFromHistory];
    for (const tx of newHistory) {
      if (!seen.has(tx.tx_hash)) {
        seen.add(tx.tx_hash);
        merged.push(tx);
      }
    }

    this.lastConfirmedHeight = merged.reduce(
      (max, tx) => (tx.height > 0 ? Math.max(max, tx.height) : max),
      fromHeight,
    );

    // Update live state
    this.utxos = utxos;
    this.rawHistory = merged;

    // Persist to cache
    this.walletCache.setStatusAndUtxos(
      addr,
      status,
      utxos,
      merged,
      this.lastConfirmedHeight,
    );
  }

  private notifyWatchCallbacks(status: string | null, address: string) {
    for (const callback of this.watchCallbacks) {
      runCallback(() => callback(status, address));
    }
  }

  public override async watchStatus(
    callback: (status: string | null, address: string) => unknown,
  ): Promise<CancelFn> {
    await this.watched();

    this.watchCallbacks.push(callback);

    return async () => {
      const index = this.watchCallbacks.indexOf(callback);
      if (index > -1) {
        this.watchCallbacks.splice(index, 1);
      }
    };
  }

  public override async waitForUpdate(
    options: { timeout?: number } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? 100;

    let statusResolve: () => void;
    const statusChange = new Promise<void>((resolve) => {
      statusResolve = resolve;
    });
    const cancel = await this.watchStatus(() => statusResolve());

    const timer = new Promise<void>((resolve) => setTimeout(resolve, timeout));

    await Promise.race([statusChange, timer]);
    await cancel();
  }

  public override async stop() {
    // a stopped wallet's reads no longer make a failed status watch again
    this.stopped = true;
    await super.stop();
    await this.baseCancelFn?.();
    this.baseCancelFn = undefined;
    this.watchCallbacks = [];
  }

  /**
   * getDepositAddress - get a wallet deposit address
   *
   * a high-level function,
   *
   * @see {@link https://rest-unstable.mainnet.cash/api-docs/#/wallet/depositAddress|/wallet/deposit_address} for REST endpoint
   *
   * @returns The deposit address as a string
   */
  public getDepositAddress(): string {
    return this.cashaddr;
  }

  /**
   * getChangeAddress - get a wallet change address
   *
   * a high-level function,
   *
   * @see {@link https://rest-unstable.mainnet.cash/api-docs/#/wallet/changeAddress|/wallet/change_address} for REST endpoint
   *
   * @returns The change address as a string
   */
  public getChangeAddress(): string {
    return this.cashaddr;
  }

  /**
   * getTokenDepositAddress - get a cashtoken aware wallet deposit address
   *
   * @returns The cashtoken aware deposit address as a string
   */
  public getTokenDepositAddress(): string {
    return this.tokenaddr;
  }

  /**
   * getTokenChangeAddress - get a cashtoken aware wallet change address
   *
   * @returns The cashtoken aware change address as a string
   */
  public getTokenChangeAddress(): string {
    return this.tokenaddr;
  }

  // returns the public key hash for an address
  public getPublicKeyHash(hex = false): string | Uint8Array {
    return hex ? binToHex(this.publicKeyHash) : this.publicKeyHash;
  }

  // returns the public key hash for an address
  public getPublicKey(hex = false): string | Uint8Array {
    if (this.publicKey) {
      return hex ? binToHex(this.publicKey) : this.publicKey;
    } else {
      throw Error(
        "The public key for this wallet is not known, perhaps the wallet was created to watch the *hash* of a public key? i.e. a cashaddress.",
      );
    }
  }

  // returns the public key hash for an address
  public getPublicKeyCompressed(hex = false): string | Uint8Array {
    if (this.publicKeyCompressed) {
      return hex
        ? binToHex(this.publicKeyCompressed)
        : this.publicKeyCompressed;
    } else {
      throw Error(
        "The compressed public key for this wallet is not known, perhaps the wallet was created to watch the *hash* of a public key? i.e. a cashaddress.",
      );
    }
  }

  /**
   * utxos Get unspent outputs for the wallet
   *
   */
  public async getUtxos(): Promise<Utxo[]> {
    await this.watched();
    await this.updatePromise;

    return this.utxos;
  }

  // Gets balance by summing value in all utxos in sats, those of token utxos included
  public async getBalance(): Promise<bigint> {
    await this.watched();
    await this.updatePromise;
    return sumUtxoValue(this.utxos);
  }

  // gets transaction history of this wallet
  public async getRawHistory(fromHeight: number = 0): Promise<TxI[]> {
    await this.watched();
    await this.updatePromise;

    let history = this.rawHistory;

    // unconfirmed transactions (height <= 0) are always included
    if (fromHeight > 0) {
      history = history.filter(
        (tx) => tx.height <= 0 || tx.height >= fromHeight,
      );
    }

    return history;
  }

  /**
   * getHistory gets transaction history of this wallet with most data decoded and ready to present to user, newest first
   * @note this method is heavy on network calls, if invoked in browser use of cache is advised, @see `Config.UseIndexedDBCache`
   * @note this method tries to recreate the history tab view of Electron Cash wallet, however, it may not be 100% accurate if the tnransaction value changes are the same in the same block (ordering)
   *
   * @param count optional, the newest `count` items. Default -1, meaning that all history items will be returned
   * @param concurrency optional, requests in flight at most while loading. Default 10
   *
   * @returns an array of transaction history items, with input values and addresses encoded in cashaddress format. @see `TransactionHistoryItem` type
   */
  public async getHistory({
    count = -1,
    concurrency,
  }: {
    count?: number;
    concurrency?: number;
  } = {}): Promise<TransactionHistoryItem[]> {
    await this.watched();
    await this.updatePromise;

    return getHistory({
      addresses: [this.cashaddr],
      provider: this.provider,
      count,
      utxos: this.utxos,
      concurrency,
    });
  }

  protected fromId(walletId: string): Promise<this> {
    const [walletType, networkGiven, arg1, arg2]: string[] =
      walletId.split(":");

    // checked first: a walletType is only quoted back once the id has a network part
    if (this.network != networkGiven) {
      throw networkPrefixError(networkGiven, this.network);
    }

    if (walletType !== WalletTypeEnum.Watch) {
      throw Error(
        `fromId called on a ${walletType} wallet, expected a ${WalletTypeEnum.Watch} wallet`,
      );
    }

    if (arg2) {
      return this.watchOnly(`${arg1}:${arg2}`);
    }

    return this.watchOnly(arg1);
  }

  // Initialize a watch only wallet from a cash addr
  protected async watchOnly(address: string): Promise<this> {
    if (!address?.length)
      throw Error("address is required to create a watch-only wallet");

    // @ts-ignore
    this.walletType = WalletTypeEnum.Watch;

    return this.initialize({ address, name: this.name });
  }

  /**
   * watchOnly - create a watch-only wallet
   *
   * such kind of wallet does not have a private key and is unable to spend any funds
   * however it still allows to use many utility functions such as getting and watching balance, etc.
   *
   * @param address   cashaddress, token aware cashaddress of a wallet
   *
   * @returns instantiated wallet
   */
  public static async watchOnly<T extends typeof WatchWallet>(
    this: T,
    address: string,
  ) {
    if (!address?.length)
      throw Error("address is required to create a watch-only wallet");

    return new this().watchOnly(address) as InstanceType<T>;
  }

  /**
   * fromCashaddr - create a watch-only wallet in the network derived from the address
   *
   * such kind of wallet does not have a private key and is unable to spend any funds
   * however it still allows to use many utility functions such as getting and watching balance, etc.
   *
   * @param address   cashaddress of a wallet
   *
   * @returns instantiated wallet
   */
  public static async fromCashaddr<T extends typeof WatchWallet>(
    this: T,
    address: string,
  ): Promise<InstanceType<T>> {
    if (!address?.length)
      throw Error("address is required to create a watch-only wallet");

    const prefix = derivePrefix(address);
    const networkType = networkPrefixMap[prefix] as NetworkType;
    return new this("", networkType).watchOnly(address) as InstanceType<T>;
  }

  /**
   * fromTokenaddr - create a watch-only wallet in the network derived from the address
   *
   * such kind of wallet does not have a private key and is unable to spend any funds
   * however it still allows to use many utility functions such as getting and watching balance, etc.
   *
   * @param address   token aware cashaddress of a wallet
   *
   * @returns instantiated wallet
   */
  public static async fromTokenaddr<T extends typeof WatchWallet>(
    this: T,
    address: string,
  ): Promise<InstanceType<T>> {
    if (!address?.length)
      throw Error("address is required to create a watch-only wallet");

    const prefix = derivePrefix(address);
    const networkType = networkPrefixMap[prefix] as NetworkType;
    return new this("", networkType).watchOnly(address) as InstanceType<T>;
  }

  /**
   * fromPublicKey - create a watch-only wallet in the network derived from the compressed or uncompressed public key
   *
   * such kind of wallet does not have a private key and is unable to spend any funds
   * however it still allows to use many utility functions such as getting and watching balance, etc.
   *
   * @param publicKey   compressed or uncompressed public key
   *
   * @returns instantiated wallet
   */
  public static async fromPublicKey<T extends typeof WatchWallet>(
    this: T,
    publicKey: Uint8Array,
  ): Promise<InstanceType<T>> {
    this.walletType = WalletTypeEnum.Watch;

    return new this(
      "",
      networkPrefixMap[this.networkPrefix] as NetworkType,
    ).initialize({
      publicKey: publicKey.length === 33 ? undefined : publicKey,
      publicKeyCompressed: publicKey.length === 33 ? publicKey : undefined,
    }) as InstanceType<T>;
  }
}

/**
 * Class to manage a testnet watch wallet.
 */
export class TestNetWatchWallet extends WatchWallet {
  static networkPrefix = CashAddressNetworkPrefix.testnet;
  static walletType = WalletTypeEnum.Watch;
  constructor(name = "", network = NetworkType.Testnet) {
    super(name, network);
  }
}

/**
 * Class to manage a regtest watch wallet.
 */
export class RegTestWatchWallet extends WatchWallet {
  static networkPrefix = CashAddressNetworkPrefix.regtest;
  static walletType = WalletTypeEnum.Watch;
  constructor(name = "", network = NetworkType.Regtest) {
    super(name, network);
  }
}
