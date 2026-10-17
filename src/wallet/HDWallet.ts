import {
  assertSuccess,
  CashAddressNetworkPrefix,
  decodeHdPrivateKey,
  decodeHdPublicKey,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  deriveSeedFromBip39Mnemonic,
  encodeHdPrivateKey,
  encodeHdPublicKey,
  generateBip39Mnemonic,
  HdPrivateNodeValid,
  HdPublicNodeValid,
} from "@bitauth/libauth";
import {
  deriveWalletCacheId,
  HDWalletCache,
  WalletCacheI,
} from "../cache/walletCache.js";
import { Config } from "../config.js";
import { NetworkType, prefixFromNetworkMap } from "../enum.js";
import { getHistory } from "../history/getHistory.js";
import { TransactionHistoryItem } from "../history/interface.js";
import { TxI, Utxo } from "../interface.js";
import { checkForEmptySeed } from "../util/checkForEmptySeed.js";
import {
  arrayRange,
  getNextUnusedIndex,
  getNextUnusedIndices,
} from "../util/hd.js";
import { sumUtxoValue } from "../util/sumUtxoValue.js";
import { toError } from "../util/toError.js";
import { runCallback } from "../util/watch.js";
import { BaseWallet } from "./Base.js";
import { WalletTypeEnum } from "./enum.js";
import { InvalidWalletIdError } from "./errors.js";
import {
  CancelFn,
  SendRequestOptionsI,
  WalletFactoryOptions,
} from "./interface.js";
import { OpReturnData, SendRequest, TokenSendRequest } from "./model.js";
import { networkPrefixError, walletTypeError } from "../util/walletIdError.js";

export const GAP_SIZE = 20;

export interface HDWalletOptions {
  name?: string;
  /**
   * Integer branches to track. Each branch `N` derives addresses at relative
   * path `N/i` (where `i` is the address index). Default `[0, 1]` -- deposit
   * (0) and change (1) -- matching the BIP-44 convention.
   *
   * Wallets rooted at a depth-4 (change-level) node have a single chain of
   * addresses and ignore this option; their `branches` is fixed at `[0]`.
   *
   * Must contain at least one branch.
   */
  branches?: number[];
  /** Initial per-branch indices (max-used index). */
  indices?: Record<number, number>;
  mnemonic?: string;
  derivation?: string;
  xPriv?: string;
  xPub?: string;
}

export const DEFAULT_BRANCHES: readonly number[] = [0, 1];
/** Branch convention: 0 = deposit (external), 1 = change (internal). */
export const DEPOSIT_BRANCH = 0;
export const CHANGE_BRANCH = 1;

export class HDWallet extends BaseWallet {
  readonly mnemonic!: string;
  readonly derivation: string = Config.DefaultParentDerivationPath;
  // the id of the wallet's cache record
  private readonly walletId!: string;
  declare readonly walletCache: WalletCacheI;

  private readonly xPriv!: string;
  readonly xPub!: string;

  private readonly xPrivNode!: HdPrivateNodeValid;
  private readonly xPubNode!: HdPublicNodeValid;

  // Callback type for wallet activity watching
  private walletWatchCallbacks: Array<
    (status: string | null, address: string) => void
  > = [];

  /**
   * Integer branches this wallet tracks. Set at construction; defaults to
   * `[0, 1]` (deposit, change). Wallets rooted at a depth-4 node have a
   * single chain and use `[0]`.
   */
  private branches!: ReadonlyArray<number>;

  /**
   * True when the wallet is rooted at a depth-4 (change-level) XPub/XPriv.
   * Only one address chain is reachable; the cache is queried with the bare
   * address index instead of `${branch}/${index}`.
   */
  private singleBranch: boolean = false;

  /** Per-branch: max index used for address derivation. */
  indices: Map<number, number> = new Map();
  /** Per-branch: address status array (length = watched window). */
  private statuses: Map<number, Array<string | null>> = new Map();
  /** Per-branch: cached UTXOs per address index. */
  private utxos: Map<number, Array<Utxo[]>> = new Map();
  /** Per-branch: cached raw history per address index. */
  rawHistory: Map<number, Array<TxI[]>> = new Map();
  /** Per-branch: subscription cancel functions per address index. */
  private watchCancels: Map<number, Array<CancelFn>> = new Map();

  /** Settles when the latest address discovery ends, and never rejects. */
  protected watchPromise?: Promise<any> = undefined;
  // the latest discovery, which rejects if it failed; reads await it through discovered()
  private discovery: Promise<void> = Promise.resolve();
  private discoveryFailed = false;
  private stopped = false;

  public get networkPrefix(): CashAddressNetworkPrefix {
    return prefixFromNetworkMap[this.network];
  }

  /// Create an uninitialized HDWallet, this method should not be called directly
  /// Instead static methods such as `newRandom` or `fromId` should be used
  constructor(network: NetworkType = NetworkType.Mainnet) {
    super(network);

    // @ts-ignore
    this.walletType = WalletTypeEnum.Hd;
  }

  /// Initialize the wallet given the options mnemonic, xPriv or xPub
  /// If none provided, a new random mnemonic will be generated
  /// If mnemonic or xPriv provided, the wallet will be able to sign transactions
  /// If xPub provided, the wallet will be watch-only
  /// This internal method is called by the various static constructors
  protected async initialize({
    name = "",
    branches,
    indices,
    mnemonic,
    derivation,
    xPriv,
    xPub,
  }: HDWalletOptions = {}) {
    // newRandom; an empty key given is a mistake and throws below, it never makes a random wallet
    if (xPriv === undefined && xPub === undefined && mnemonic === undefined) {
      mnemonic = generateBip39Mnemonic();
    }

    if (branches !== undefined && branches.length === 0) {
      throw new Error("HDWallet: `branches` must contain at least one entry");
    }

    // @ts-ignore
    this.xPub = xPub ? xPub : "";

    if (mnemonic?.length) {
      // @ts-ignore
      this.derivation = derivation
        ? derivation
        : Config.DefaultParentDerivationPath;
      // @ts-ignore
      this.mnemonic = mnemonic ? mnemonic : generateBip39Mnemonic();

      if (this.mnemonic.length == 0) {
        throw Error("refusing to create wallet from empty mnemonic");
      }
      if (![12, 24].includes(this.mnemonic.split(" ").length)) {
        throw Error("Invalid mnemonic, must be 12 or 24 words");
      }

      const seed = deriveSeedFromBip39Mnemonic(this.mnemonic);
      checkForEmptySeed(seed);

      const rootNode = deriveHdPrivateNodeFromSeed(seed, {
        assumeValidity: true,
        throwErrors: true,
      });
      const node = deriveHdPath(rootNode, this.derivation);
      // @ts-ignore
      this.xPriv = assertSuccess(
        encodeHdPrivateKey({
          ...node,
          network: this.network === NetworkType.Mainnet ? "mainnet" : "testnet",
          node: node,
        }),
      ).hdPrivateKey;
      // @ts-ignore
      this.xPrivNode = node;

      // @ts-ignore
      this.xPubNode = deriveHdPublicNode(node);
      // @ts-ignore
      this.xPub = assertSuccess(
        encodeHdPublicKey({
          node: this.xPubNode,
          network: this.network === NetworkType.Mainnet ? "mainnet" : "testnet",
        }),
      ).hdPublicKey;
    } else if (xPriv) {
      // @ts-ignore
      this.xPriv = xPriv;

      const decoded = assertSuccess(decodeHdPrivateKey(xPriv));
      if (
        decoded.network !==
        (this.network === NetworkType.Mainnet ? "mainnet" : "testnet")
      ) {
        throw new Error(
          `xPriv network (${decoded.network}) does not match wallet network (${
            this.network === NetworkType.Mainnet ? "mainnet" : "testnet"
          })`,
        );
      }
      // @ts-ignore
      this.xPrivNode = decoded.node;

      // @ts-ignore
      this.xPubNode = deriveHdPublicNode(decoded.node);
      // @ts-ignore
      this.xPub = assertSuccess(
        encodeHdPublicKey({
          node: this.xPubNode,
          network: this.network === NetworkType.Mainnet ? "mainnet" : "testnet",
        }),
      ).hdPublicKey;
    } else if (xPub) {
      const decoded = assertSuccess(decodeHdPublicKey(xPub));
      if (
        decoded.network !==
        (this.network === NetworkType.Mainnet ? "mainnet" : "testnet")
      ) {
        throw new Error(
          `xPriv network (${decoded.network}) does not match wallet network (${
            this.network === NetworkType.Mainnet ? "mainnet" : "testnet"
          })`,
        );
      }

      // @ts-ignore
      this.xPubNode = decoded.node;
      // @ts-ignore
      this.xPub = xPub;
    } else {
      throw new Error(
        "mnemonic, xPriv or xPub must be provided to create an HDWallet",
      );
    }

    this.name = name;

    // @ts-ignore
    this.walletId = deriveWalletCacheId(
      (this.mnemonic ? this.mnemonic + this.derivation : undefined) ??
        this.xPriv ??
        this.xPub,
      this.network,
    );
    // Resolve the effective branches.
    const cacheNode = this.xPrivNode ?? this.xPubNode;
    if (cacheNode.depth > 4) {
      throw new Error(
        `HDWallet: HD node depth ${cacheNode.depth} is too deep; address-level keys cannot derive further children`,
      );
    }
    this.singleBranch = cacheNode.depth === 4;
    if (this.singleBranch) {
      // Depth-4 wallets are a single chain; the branch axis doesn't apply.
      // We expose a `[0]` branch list so the rest of the wallet code can treat
      // them uniformly (with derivation taking the bare index, no prefix).
      this.branches = Object.freeze([0]);
    } else {
      this.branches = Object.freeze(
        branches !== undefined ? [...branches] : [...DEFAULT_BRANCHES],
      );
    }
    for (const branch of this.branches) {
      this.indices.set(branch, indices?.[branch] ?? 0);
      this.statuses.set(branch, []);
      this.utxos.set(branch, []);
      this.rawHistory.set(branch, []);
      this.watchCancels.set(branch, []);
    }

    // @ts-ignore
    this.walletCache = new HDWalletCache(
      this.walletId,
      cacheNode,
      this.networkPrefix,
    );

    // init wallet cache
    await this.walletCache.init();
    // start watching addresses asynchronously
    void this.startDiscovery();

    return this;
  }

  /// Stops the wallet from watching for address changes
  /// After calling this method, the wallet will no longer update and is considered defunct
  public override async stop() {
    // a stopped wallet's reads no longer retry a failed discovery, which would subscribe again
    this.stopped = true;
    const cancels: Promise<void>[] = [super.stop()];
    for (const branch of this.branches) {
      for (const fn of this.watchCancels.get(branch) ?? []) {
        if (fn) cancels.push(fn());
      }
    }
    await Promise.all(cancels);
    for (const branch of this.branches) {
      this.watchCancels.set(branch, []);
    }
    this.walletWatchCallbacks = [];
    // no write of the cache is left for later; one that fails is a cache entry lost, not an error
    await this.walletCache.flush().catch(() => {});
  }

  /// Run address discovery once the one in progress has ended. If it fails, the next read runs
  /// it again: the addresses it could not watch are left unwatched, so the next run retries them
  private startDiscovery(gapSize: number = GAP_SIZE): Promise<void> {
    this.discoveryFailed = false;
    const run = this.discovery
      .catch(() => {})
      .then(() => this.makeWatchPromise(gapSize));
    this.discovery = run;
    this.watchPromise = run.then(
      () => {},
      () => {
        if (this.discovery === run) this.discoveryFailed = true;
      },
    );
    return run;
  }

  /// Wait for address discovery, running it again first if the last one failed; rejects with
  /// the error of a discovery that fails, rather than reading an incomplete set of addresses
  private discovered(): Promise<void> {
    if (this.discoveryFailed && !this.stopped) void this.startDiscovery();
    return this.discovery;
  }

  /// Internal method to start watching addresses for activity, extending the watched range as needed
  private async makeWatchPromise(gapSize: number = GAP_SIZE) {
    let needsMore = true;
    while (needsMore) {
      // every branch settles before this fails; an address whose first status failed before its
      // subscribe resolved ends that subscription itself once it does
      const results = await Promise.allSettled(
        this.branches.map((branch) => this.watchBranch(branch, gapSize)),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;

      // Check if we have a full gap of addresses beyond the last used index
      // for every tracked branch.
      needsMore = this.branches.some((branch) => {
        const gap =
          this.watchedLength(branch) - (this.indices.get(branch) ?? 0);
        return gap < gapSize;
      });
    }
  }

  /// The addresses of a branch watched without a break: a failed discovery leaves an address
  /// unwatched, and the gap ends there so that the next extension subscribes it again
  private watchedLength(branch: number): number {
    const statuses = this.statuses.get(branch)!;
    const firstUnwatched = statuses.findIndex((status) => status === undefined);
    if (firstUnwatched === -1) return statuses.length;
    return firstUnwatched;
  }

  /// Watch addresses of a specific branch for activity
  private async watchBranch(branch: number, gapSize: number): Promise<number> {
    const statuses = this.statuses.get(branch)!;
    const utxosArray = this.utxos.get(branch)!;
    const historyArray = this.rawHistory.get(branch)!;
    const watchCancels = this.watchCancels.get(branch)!;
    const getCurrentIndex = () => this.indices.get(branch) ?? 0;
    const setCurrentIndex = (val: number) => {
      this.indices.set(branch, val);
    };

    const startIndex = this.watchedLength(branch);
    const stopIndex = getCurrentIndex() + gapSize;

    const addresses = arrayRange(startIndex, stopIndex).map(
      (i) => this.walletCache.getByPath(this.addressPath(branch, i)).address,
    );

    const results = await Promise.allSettled(
      addresses.map(
        (addr, idx) =>
          new Promise<void>((resolve, reject) => {
            const index = startIndex + idx;
            let discovered = false;
            let failed = false;

            if (statuses[index] !== undefined) {
              resolve();
              return;
            }

            const {
              status: prevStatus,
              utxos: prevUtxos,
              rawHistory: prevRawHistory,
              lastConfirmedHeight: prevLastConfirmedHeight,
            } = this.walletCache.getByPath(this.addressPath(branch, index));
            statuses[index] = prevStatus;
            utxosArray[index] = prevUtxos;
            historyArray[index] = prevRawHistory;

            // Track lastConfirmedHeight in closure, updated after each fetch
            let lastConfirmedHeight = prevLastConfirmedHeight;

            // An address whose subscription or first status fails is left unwatched, so that the
            // next discovery subscribes it again
            const fail = (error: unknown) => {
              // only the first failure: a retry may already be watching the address again
              if (failed) return;
              failed = true;
              statuses[index] = undefined as any;
              watchCancels[index]?.().catch(() => {});
              reject(toError(error));
            };

            const callback = async (
              args: [address: string, status: string | null],
            ) => {
              const [address, status] = args;
              if (address != addr || failed) {
                return;
              }
              try {
                await update(status);
                discovered = true;
                resolve();
              } catch (error) {
                // a later fetch that fails leaves the old status, so the next notification fetches again
                if (!discovered) fail(error);
              }
            };

            const update = async (status: string | null) => {
              if (status === null) {
                utxosArray[index] = [];
                historyArray[index] = [];
              }

              if (status !== null && status !== statuses[index]) {
                // Use lastConfirmedHeight from closure for incremental fetch
                const fromHeight = lastConfirmedHeight;
                const currentHistory = historyArray[index] || [];

                const [utxos, newHistory] = await Promise.all([
                  this.provider.getUtxos(addr).then((utxos) =>
                    utxos.map((utxo) => {
                      utxo.address = addr;
                      return utxo;
                    }),
                  ),
                  // Fetch only from last confirmed height to reduce server load
                  this.provider.getHistory(addr, fromHeight),
                ]);
                // failed while fetching, so the address must stay unwatched for a retry
                if (failed) return;

                // Merge: keep confirmed items from current history, add new items
                const confirmedFromHistory = currentHistory.filter(
                  (tx) => tx.height > 0 && tx.height < fromHeight,
                );
                const seen = new Set(
                  confirmedFromHistory.map((tx) => tx.tx_hash),
                );
                const merged = [...confirmedFromHistory];
                for (const tx of newHistory) {
                  if (!seen.has(tx.tx_hash)) {
                    seen.add(tx.tx_hash);
                    merged.push(tx);
                  }
                }

                // Update lastConfirmedHeight in closure
                lastConfirmedHeight = merged.reduce(
                  (max, tx) => (tx.height > 0 ? Math.max(max, tx.height) : max),
                  fromHeight,
                );

                utxosArray[index] = utxos;
                historyArray[index] = merged;
                this.walletCache.setStatusAndUtxos(
                  addr,
                  status,
                  utxos,
                  merged,
                  lastConfirmedHeight,
                );
              }
              statuses[index] = status;

              if (status !== null) {
                const newIndex = index + 1;
                if (newIndex > getCurrentIndex()) {
                  setCurrentIndex(newIndex);
                }

                // Maintain the gap: extend watched range if it shrank
                const gap = this.watchedLength(branch) - getCurrentIndex();
                if (gap < gapSize && discovered) {
                  // as a discovery of its own, so that a failure reaches the next read
                  void this.startDiscovery(gapSize);
                } else if (gap < gapSize) {
                  await this.watchBranch(branch, gapSize);
                }
              }

              // Notify wallet watchers of the status change
              this.notifyWalletWatchers(status, addr);
            };

            this.subscribe((provider) =>
              provider.subscribeToAddress(addr, callback as any),
            ).then((cancel) => {
              if (failed) {
                cancel().catch(() => {});
              } else {
                watchCancels[index] = cancel;
              }
            }, fail);
          }),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;

    return addresses.length;
  }

  /// Internal method called when any address status changes
  private notifyWalletWatchers(status: string | null, address: string) {
    for (const callback of this.walletWatchCallbacks) {
      try {
        callback(status, address);
      } catch {
        // Ignore callback errors to not break other watchers
      }
    }
  }

  /**
   * Watch wallet for any activity (status changes on any address)
   * This is the foundation for watchWalletBalance and watchWalletTransactions
   * @param callback - Called when any address in the wallet has a status change; its errors go to
   * console.error
   * @param options - `debounce` (ms, default 100)
   * @returns Cancel function to stop watching
   */
  protected override async watchStatus(
    callback: (status: string | null, address: string) => unknown,
    options: { debounce?: number } = {},
  ): Promise<CancelFn> {
    const debounce = options.debounce ?? 100;
    await this.discovered();

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingStatus: string | null = null;
    let pendingAddress: string = "";

    const debouncedCallback = (status: string | null, address: string) => {
      pendingStatus = status;
      pendingAddress = address;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        // the Base watchers read in their callback, which rejects while discovery is failed
        runCallback(() => callback(pendingStatus, pendingAddress));
      }, debounce);
    };

    this.walletWatchCallbacks.push(debouncedCallback);

    return async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const index = this.walletWatchCallbacks.indexOf(debouncedCallback);
      if (index > -1) {
        this.walletWatchCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Wait until the wallet's per-branch indices reach the specified targets,
   * or until an idle-timeout window passes with no further status changes.
   */
  protected override async waitForUpdate(
    options: {
      /** Target indices keyed by branch number. Wait until each tracked branch
       *  has reached at least the specified index. */
      indices?: Record<number, number>;
      timeout?: number;
    } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? 100;

    const targets: Record<number, number> = { ...options.indices };

    const isSatisfied = () => {
      for (const [branch, target] of Object.entries(targets)) {
        const current = this.indices.get(Number(branch)) ?? 0;
        if (current < target) return false;
      }
      return true;
    };

    if (isSatisfied()) return;

    // Single watcher that resolves a rotating promise on each status change
    let statusResolve: () => void;
    const cancel = await this.watchStatus(() => {
      statusResolve?.();
    });

    // Race status changes against idle timeout; reset timeout on each change
    while (!isSatisfied()) {
      const statusChange = new Promise<"status">((resolve) => {
        statusResolve = () => resolve("status");
      });
      const idle = new Promise<"idle">((resolve) =>
        setTimeout(resolve, timeout, "idle"),
      );

      if ((await Promise.race([statusChange, idle])) === "idle") break;
    }

    await cancel();
  }

  /**
   * Watch wallet for new transactions (HD wallet override)
   *
   * Uses unfiltered history so that seenTxHashes always covers all known
   * transactions, including those from newly discovered addresses when any
   * tracked branch's index advances and widens getRawHistory's scope.
   */
  protected override async watchTransactionHashes(
    callback: (txHash: string) => unknown,
  ): Promise<CancelFn> {
    // Seeded before subscribing so the history at setup is not reported as new
    const existing = await this.getRawHistory();
    const seenTxHashes = new Set(existing.map((tx) => tx.tx_hash));

    return this.watchStatus(async () => {
      const history = await this.getRawHistory();

      const newTxHashes: string[] = [];

      for (const tx of history) {
        if (!seenTxHashes.has(tx.tx_hash)) {
          seenTxHashes.add(tx.tx_hash);
          newTxHashes.push(tx.tx_hash);
        }
      }

      // each on its own, so that one failing does not keep the others from being reported
      for (const txHash of newTxHashes) {
        runCallback(() => callback(txHash));
      }
    });
  }

  /// Collect the cached UTXOs of every tracked branch.
  private collectUtxosFromBranches(): Utxo[] {
    const out: Utxo[] = [];
    for (const branch of this.branches) {
      for (const arr of this.utxos.get(branch) ?? []) {
        out.push(...arr);
      }
    }
    return out;
  }

  /** utxos Get unspent outputs of every tracked branch. */
  public async getUtxos(): Promise<Utxo[]> {
    await this.discovered();

    return this.collectUtxosFromBranches();
  }

  // Gets balance by summing value in all utxos in sats, those of token utxos included
  public async getBalance(): Promise<bigint> {
    await this.discovered();

    return sumUtxoValue(this.collectUtxosFromBranches());
  }

  /// Relative derivation path for an address slot. Single-branch (depth-4)
  /// wallets ignore the branch component and derive at just the address
  /// index. Otherwise the standard `${branch}/${index}` convention is used.
  private addressPath(branch: number, index: number): string {
    return this.singleBranch ? `${index}` : `${branch}/${index}`;
  }

  /// Throw if the wallet does not track the requested branch.
  private requireBranch(branch: number): void {
    if (!this.branches.includes(branch)) {
      throw new Error(
        `HDWallet: branch ${branch} is not tracked (tracked: [${this.branches.join(", ")}])`,
      );
    }
  }

  /**
   * Get the address at the given branch and index. If `index` is `-1`
   * (the default), the next unused index on that branch is selected.
   *
   * Throws if the branch is not tracked by this wallet.
   */
  public getAddressByBranch(branch: number, index: number = -1): string {
    this.requireBranch(branch);
    const statuses = this.statuses.get(branch)!;
    index = getNextUnusedIndex(index, statuses);
    return this.walletCache.getByPath(this.addressPath(branch, index)).address;
  }

  /** Same as {@link getAddressByBranch} but returning the token-address form. */
  public getTokenAddressByBranch(branch: number, index: number = -1): string {
    this.requireBranch(branch);
    const statuses = this.statuses.get(branch)!;
    index = getNextUnusedIndex(index, statuses);
    return this.walletCache.getByPath(this.addressPath(branch, index))
      .tokenAddress;
  }

  /// Get next unused deposit address (branch 0), or the address at the
  /// specified index. Convenience alias for `getAddressByBranch(0, index)`.
  public getDepositAddress(index: number = -1): string {
    return this.getAddressByBranch(DEPOSIT_BRANCH, index);
  }

  /// Get next unused token deposit address (branch 0), or the token address
  /// at the specified index.
  public getTokenDepositAddress(index: number = -1): string {
    return this.getTokenAddressByBranch(DEPOSIT_BRANCH, index);
  }

  protected override getTokenDepositAddresses(count: number): string[] {
    this.requireBranch(DEPOSIT_BRANCH);
    const statuses = this.statuses.get(DEPOSIT_BRANCH)!;
    return getNextUnusedIndices(count, statuses).map((index) =>
      this.getTokenDepositAddress(index),
    );
  }

  /// Get next unused change address (branch 1), or the address at the
  /// specified index. For depth-4 (single-branch) wallets branch 1 is not
  /// tracked; the deposit branch is used instead.
  public getChangeAddress(index: number = -1): string {
    if (this.singleBranch || !this.branches.includes(CHANGE_BRANCH)) {
      return this.getDepositAddress(index);
    }
    return this.getAddressByBranch(CHANGE_BRANCH, index);
  }

  /// Get next unused token change address (branch 1), or the token address at
  /// the specified index. For depth-4 (single-branch) wallets branch 1 is not
  /// tracked; the deposit branch is used instead.
  protected getTokenChangeAddress(index: number = -1): string {
    if (this.singleBranch || !this.branches.includes(CHANGE_BRANCH)) {
      return this.getTokenDepositAddress(index);
    }
    return this.getTokenAddressByBranch(CHANGE_BRANCH, index);
  }

  public hasAddress(address: string): boolean {
    return this.walletCache.get(address) !== undefined;
  }

  /**
   * newRandom - create a random wallet
   *
   * if `name` parameter is specified, the wallet is got or created as with `named(name)`
   *
   * @param name   user friendly wallet alias
   * @param options   the wallet's provider
   *
   * @returns instantiated wallet
   */
  public static async newRandom<T extends typeof HDWallet>(
    this: T,
    name: string = "",
    options?: WalletFactoryOptions,
  ): Promise<InstanceType<T>> {
    if (name.length > 0) {
      return this.named(name, options);
    }

    return this.create(options).initialize() as Promise<InstanceType<T>>;
  }

  /**
   * fromId - create a wallet from encoded walletId string: `hd:<network>:<mnemonic>[:<derivation
   * path>[:<deposit index>:<change index>]]`, `hd:<network>:<xprv or xpub>[:<deposit index>:<change
   * index>]` or `named:<network>:<name>`
   *
   * @param walletId   walletId options to steer the creation process
   * @param options   the wallet's provider
   *
   * @returns wallet instantiated accordingly to the walletId rules
   */
  public static async fromId<T extends typeof HDWallet>(
    this: T,
    walletId: string,
    options?: WalletFactoryOptions,
  ): Promise<InstanceType<T>> {
    return this.create(options).fromId(walletId) as Promise<InstanceType<T>>;
  }

  /// override the base class fromId method implementation
  protected async fromId(walletId: string): Promise<this> {
    const [walletType, networkGiven, arg1, arg2, arg3, arg4] =
      walletId.split(":");

    if (this.network != networkGiven) {
      throw networkPrefixError(walletType, networkGiven, this.network);
    }

    if (walletType === WalletTypeEnum.Named) {
      // named:testnet:wallet_1, or named:testnet:wallet_1:bchtest
      return this.fromNamedId(arg1, arg2);
    }

    if (walletType !== WalletTypeEnum.Hd) {
      throw walletTypeError(walletType, WalletTypeEnum.Hd);
    }

    if (!arg1) {
      throw new InvalidWalletIdError(
        "refusing to create wallet from a walletId without a key",
        { kind: walletType, reason: "missing-value" },
      );
    }

    // the whole prefix: a Czech mnemonic can start with "zprvu"
    if (arg1.startsWith("xprv") || arg1.startsWith("tprv")) {
      return this.initialize({
        xPriv: arg1,
        indices: {
          [DEPOSIT_BRANCH]: parseInt(arg2) || 0,
          [CHANGE_BRANCH]: parseInt(arg3) || 0,
        },
      });
    }

    if (arg1.startsWith("pub", 1)) {
      return this.initialize({
        xPub: arg1,
        indices: {
          [DEPOSIT_BRANCH]: parseInt(arg2) || 0,
          [CHANGE_BRANCH]: parseInt(arg3) || 0,
        },
      });
    }

    return this.initialize({
      mnemonic: arg1,
      derivation: arg2,
      indices: {
        [DEPOSIT_BRANCH]: parseInt(arg3) || 0,
        [CHANGE_BRANCH]: parseInt(arg4) || 0,
      },
    });
  }

  /**
   * encodeTransaction Encode and sign a transaction given a list of sendRequests, options and estimate fees.
   * @param  {SendRequest[]} sendRequests SendRequests
   * @param  {boolean} discardChange=false
   * @param  {SendRequestOptionsI} options Options of the send requests
   */
  protected async encodeTransaction(
    requests:
      | SendRequest
      | TokenSendRequest
      | OpReturnData
      | Array<SendRequest | TokenSendRequest | OpReturnData>,
    discardChange: boolean = false,
    options?: SendRequestOptionsI,
    privateKey?: Uint8Array,
  ) {
    if (!this.xPriv && !privateKey) {
      throw new Error(`Missing private key`);
    }

    return super.encodeTransaction(
      requests,
      discardChange,
      options,
      privateKey,
    );
  }

  //#region Serialization
  /**
   * toDbString - store the serialized version of the wallet in the database, not just the name
   *
   * @throws {Error} if called on BaseWallet
   */
  public toDbString() {
    if (this.walletType == WalletTypeEnum.Hd) {
      // Serialize indices for branches 0 and 1 only -- the persisted format
      // pre-dates arbitrary-branch tracking. Non-default branches are not
      // serialized; if the wallet is restored, its branches list will revert
      // to the default and the extra branches will need to be re-supplied.
      const depositIdx = this.indices.get(DEPOSIT_BRANCH) ?? 0;
      const changeIdx = this.indices.get(CHANGE_BRANCH) ?? 0;
      if (this.mnemonic?.length > 0) {
        return `${this.walletType}:${this.network}:${this.mnemonic}:${this.derivation}:${depositIdx}:${changeIdx}`;
      }

      if (this.xPriv?.length > 0) {
        return `${this.walletType}:${this.network}:${this.xPriv}:${depositIdx}:${changeIdx}`;
      }

      if (this.xPub?.length > 0) {
        return `${this.walletType}:${this.network}:${this.xPub}:${depositIdx}:${changeIdx}`;
      }

      throw Error("HDWallet has no mnemonic, xPriv or xPub to serialize");
    }

    throw Error("toDbString unsupported wallet type");
  }
  //#endregion Serialization

  /**
   * getHistory gets transaction history of this wallet with most data decoded and ready to present to user, newest first
   * @note this method is heavy on network calls, if invoked in browser use of cache is advised, @see `Config.UseIndexedDBCache`
   * @note this method tries to recreate the history tab view of Electron Cash wallet, however, it may not be 100% accurate if the tnransaction value changes are the same in the same block (ordering)
   *
   * @param count optional, the newest `count` items. Default -1, meaning that all history items will be returned
   * @param concurrency optional, requests in flight at most while loading, `Infinity` for no limit. Default 10
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
    const rawHistory = await this.getRawHistory();
    const addresses = this.getUsedAddresses();
    const utxos = this.collectUtxosFromBranches();

    return getHistory({
      addresses: addresses,
      provider: this.provider,
      count,
      rawHistory,
      utxos,
      concurrency,
    });
  }

  // get all used addresses across all tracked branches
  private getUsedAddresses(): string[] {
    const addrs: string[] = [];
    for (const branch of this.branches) {
      const statuses = this.statuses.get(branch) ?? [];
      const maxIdx = this.indices.get(branch) ?? 0;
      for (let i = 0; i < statuses.length; i++) {
        if (statuses[i] !== null && i < maxIdx) {
          addrs.push(
            this.walletCache.getByPath(this.addressPath(branch, i)).address,
          );
        }
      }
    }
    return addrs;
  }

  /** The wallet's transaction history, over every tracked branch. */
  public async getRawHistory(fromHeight: number = 0): Promise<TxI[]> {
    await this.discovered();

    const historyArrays: TxI[][] = [];
    for (const branch of this.branches) {
      const arrs = this.rawHistory.get(branch) ?? [];
      const maxIdx = this.indices.get(branch) ?? 0;
      historyArrays.push(...arrs.slice(0, maxIdx));
    }

    // Deduplicate by tx_hash
    const seen = new Set<string>();
    let history: TxI[] = [];
    for (const arr of historyArrays) {
      for (const tx of arr) {
        if (!seen.has(tx.tx_hash)) {
          seen.add(tx.tx_hash);
          history.push(tx);
        }
      }
    }

    // unconfirmed transactions (height <= 0) are always included
    if (fromHeight > 0) {
      history = history.filter(
        (tx) => tx.height <= 0 || tx.height >= fromHeight,
      );
    }

    // Sort by height (descending, unconfirmed first)
    return history.sort((a, b) => {
      if (a.height <= 0 && b.height > 0) return -1;
      if (b.height <= 0 && a.height > 0) return 1;
      return b.height - a.height;
    });
  }
}

/**
 * Class to manage a testnet wallet.
 */
export class TestNetHDWallet extends HDWallet {
  constructor() {
    super(NetworkType.Testnet);
  }
}

/**
 * Class to manage a regtest wallet.
 */
export class RegTestHDWallet extends HDWallet {
  constructor() {
    super(NetworkType.Regtest);
  }
}
