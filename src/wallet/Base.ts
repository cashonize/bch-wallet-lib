import {
  binToHex,
  cashAddressToLockingBytecode,
  CashAddressNetworkPrefix,
  decodeTransaction,
  encodeCashAddress,
  getDustThreshold,
  lockingBytecodeToCashAddress,
  sha256,
} from "@bitauth/libauth";
import {
  purgeWalletCache,
  WalletCache,
  walletCacheIdFromWalletId,
} from "../cache/walletCache.js";
import { DUST_UTXO_THRESHOLD } from "../constant.js";
import StorageProvider from "../db/StorageProvider.js";
import { NetworkType } from "../enum.js";
import type { Network } from "../interface.js";
import { knownNetworks, networkConfig } from "../network/registry.js";
import { HexHeaderI, NFTCapability, TxI, Utxo } from "../interface.js";
import { getNetworkProvider } from "../network/default.js";
import ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";
import { getRelayFeeCache } from "../network/getRelayFeeCache.js";
import { ElectrumRawTransaction } from "../network/interface.js";
import {
  amountNotMetError,
  buildEncodedTransaction,
  getFeeAmount,
  getFeeAmountSimple,
  getFeeAmountWithoutChange,
  getSuitableUtxos,
  getTokenChangeRequests,
  placeholderPrivateKeyBin,
  selectFungibleTokenUtxos,
} from "../transaction/Wif.js";
import type { TokenBurnAllowance } from "../transaction/tokenConservation.js";
import { asSendRequestObject } from "../util/asSendRequestObject.js";
import { checkUtxos, toOutpoint } from "../util/checkUtxos.js";
import { deriveLockscript } from "../util/deriveLockscript.js";
import { Limiter } from "../util/mapConcurrent.js";
import {
  getRuntimePlatform,
  sumUtxoValue,
  toTokenaddr,
} from "../util/index.js";
import { sumSendRequestAmounts } from "../util/sumSendRequestAmounts.js";
import { tokenOutput } from "../util/tokenOutput.js";
import { walletIdKind } from "../util/walletIdError.js";
import { runCallback } from "../util/watch.js";
import { WalletTypeEnum } from "./enum.js";
import {
  InsufficientFundsError,
  InvalidRequestError,
  InvalidWalletIdError,
  UtxoNotAvailableError,
  WatchOnlyError,
} from "./errors.js";
import {
  CancelFn,
  SendRequestOptionsI,
  WalletFactoryOptions,
} from "./interface.js";
import {
  fromUtxoId,
  OpReturnData,
  SendRequest,
  SendRequestType,
  SendResponse,
  checkGenesisRequest,
  toTokenAmount,
  TokenBurnRequest,
  TokenGenesisRequest,
  TokenMintRequest,
  TokenSendRequest,
  toUtxoId,
} from "./model.js";

// How long a broadcast waits for the wallet's own coins to reflect it, once the server reports it
const COIN_VIEW_TIMEOUT = 10_000;
// Subscriptions setProvider moves at once, as many as discovery makes at once
const MOVE_CONCURRENCY = 50;

export const placeholderCashAddr =
  "bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603";

// A P2SH32 address, the largest standard output, so that a max sized with it pays enough for any
// destination
const placeholderP2sh32Addr = encodeCashAddress({
  prefix: "bitcoincash",
  type: "p2sh",
  payload: new Uint8Array(32),
}).address;

// A token coin a sweep spends for its satoshis comes back as it was, holding its dust limit only
function sweptTokenReturn(coin: Utxo, cashaddr: string): TokenSendRequest {
  const token = coin.token!;
  const request = {
    cashaddr,
    category: token.category,
    amount: token.amount,
    nft: token.nft
      ? { capability: token.nft.capability, commitment: token.nft.commitment }
      : undefined,
  };
  const dustLimit = getDustThreshold(
    tokenOutput(new TokenSendRequest({ ...request, value: 1n })),
  );
  return new TokenSendRequest({ ...request, value: dustLimit });
}

interface WalletSubscription {
  subscribe: (provider: ElectrumNetworkProvider) => Promise<CancelFn>;
  cancel: CancelFn;
  // the provider `cancel` belongs to
  provider: ElectrumNetworkProvider;
}

// a provider's cancel may be reached twice when a subscription is cancelled while it moves
function once(cancel: CancelFn): CancelFn {
  let done: Promise<void> | undefined;
  return () => (done ??= cancel());
}

function checkProviderNetwork(
  provider: ElectrumNetworkProvider,
  network: Network,
) {
  if ((provider.network as string) !== network) {
    throw new Error(
      `a ${provider.network} provider cannot serve a ${network} wallet`,
    );
  }
}

/**
 * A class to hold features used by all wallets
 * @class  BaseWallet
 */
export class BaseWallet {
  public static StorageProvider?: typeof StorageProvider;

  readonly walletCache: WalletCache;
  // set by the factory that made the wallet; a wallet made with `new` takes the global one on first use
  private _provider?: ElectrumNetworkProvider;
  readonly network: Network;
  protected readonly walletType: WalletTypeEnum;
  name: string = "";
  private subscriptions = new Set<WalletSubscription>();
  // Bumped by stop(), so that a subscription still being made when it ran is ended, not kept
  private stops = 0;
  private providerSwitch: Promise<void> = Promise.resolve();

  /** The electrum provider this wallet talks to; change it with setProvider() */
  public get provider(): ElectrumNetworkProvider {
    this._provider ??= this.getNetworkProvider(this.network);
    return this._provider;
  }

  public get networkPrefix(): CashAddressNetworkPrefix {
    return networkConfig(this.network)
      .addressPrefix as CashAddressNetworkPrefix;
  }

  //#region Accessors
  protected getNetworkProvider(
    network: Network = NetworkType.Mainnet,
  ): ElectrumNetworkProvider {
    return getNetworkProvider(network);
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
    // return this.cashaddr;
    throw Error("getDepositAddress not implemented in BaseWallet");
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
    // return this.cashaddr;
    throw Error("getChangeAddress not implemented in BaseWallet");
  }

  /**
   * getTokenDepositAddress - get a cashtoken aware wallet deposit address
   *
   * @returns The cashtoken aware deposit address as a string
   */
  public getTokenDepositAddress(): string {
    // return this.tokenaddr;
    throw Error("getTokenDepositAddress not implemented in BaseWallet");
  }

  /**
   * Token deposit addresses for `count` outputs that default to this wallet
   * in one transaction; an HD wallet gives each its own unused address.
   */
  protected getTokenDepositAddresses(count: number): string[] {
    return Array.from({ length: count }, () => this.getTokenDepositAddress());
  }

  /**
   * Change addresses for `count` outputs of one transaction; an HD wallet gives each its own
   * unused address, a single-address wallet has the one.
   */
  protected getChangeAddresses(count: number): string[] {
    return Array.from({ length: count }, () => this.getChangeAddress());
  }

  /**
   * Where one transaction's change goes: the BCH change to one address and every token change
   * output to another of its own, so that a coin later sent on from one of them shows nothing of
   * the others. The token outputs take the addresses after the BCH change's in the order they ask
   * for them, so the ones used stay contiguous. Every plan starts from the same unused addresses:
   * a token operation that places its own token change agrees with its send on the BCH change's.
   */
  protected planChangeAddresses() {
    const bch = this.getChangeAddresses(1)[0]!;
    let taken = 1;
    const token = (): string => {
      taken += 1;
      return toTokenaddr(this.getChangeAddresses(taken)[taken - 1]!);
    };
    return { bch, token };
  }

  // check if a given address belongs to this wallet
  public hasAddress(address: string): boolean {
    return (
      address === this.getDepositAddress() ||
      address === this.getChangeAddress()
    );
  }

  /** Whether the coins of an address of this wallet reach its view, i.e. it is subscribed to */
  protected watchesAddress(address: string): boolean {
    return this.hasAddress(address);
  }
  //#endregion Accessors

  //#region Constructors and Statics
  /**
   * constructor for a new wallet
   * @param network              network for wallet
   *
   * @throws {Error} if called on BaseWallet
   */
  constructor(network: Network = NetworkType.Mainnet) {
    this.network = network;
    this.walletType = WalletTypeEnum.Watch;
    this.walletCache = new Map<string, { privateKey: Uint8Array }>();
  }
  //#endregion Constructors

  /**
   * The instance a factory initializes, on the provider of `options` or else the network's global
   * one, so that its first subscription is made on the provider it keeps
   */
  protected static create<T extends typeof BaseWallet>(
    this: T,
    options: WalletFactoryOptions = {},
  ): InstanceType<T> {
    const wallet: BaseWallet = new this();
    if (options.network !== undefined && options.network !== wallet.network) {
      if (wallet.network !== NetworkType.Mainnet) {
        throw new Error(
          `a ${wallet.network} wallet class cannot make a ${options.network} wallet`,
        );
      }
      networkConfig(options.network);
      // @ts-ignore
      wallet.network = options.network;
    }
    if (options.provider) {
      checkProviderNetwork(options.provider, wallet.network);
    }
    wallet._provider =
      options.provider ?? wallet.getNetworkProvider(wallet.network);
    return wallet as InstanceType<T>;
  }

  /**
   * named (internal) get a named wallet from the database of the wallet's network, or create a
   * new one there.
   *
   * @param {string} name              name of the wallet
   *
   * @returns a promise to a named wallet
   */
  protected async named(name: string): Promise<this> {
    if (!name?.length) {
      throw Error("Named wallets must have a non-empty name");
    }
    _checkContextSafety(this.network);
    this.name = name;
    const db = getStorageProvider(networkConfig(this.network).dbName);

    // If there is a database, force saving or error
    if (db) {
      await db.init();
      const savedWalletRecord = await db.getWallet(name);
      if (savedWalletRecord) {
        await db.close();
        const recoveredWallet = await this.fromId(savedWalletRecord.wallet);
        recoveredWallet.name = savedWalletRecord.name;
        return recoveredWallet;
      } else {
        const wallet = await this.initialize();
        wallet.name = name;
        await db.addWallet(wallet.name, wallet.toDbString());
        await db.close();
        return wallet;
      }
    } else {
      throw Error(
        "No database was available or configured to store the named wallet.",
      );
    }
  }

  /**
   * replaceNamed - Replace (recover) named wallet with a new walletId
   *
   * If wallet with a provided name does not exist yet, it will be created with a `walletId` supplied
   * If wallet exists it will be overwritten without exception
   *
   * @param name   user friendly wallet alias
   * @param walletId walletId options to steer the creation process
   *
   * @returns instantiated wallet
   */
  protected async replaceNamed(name: string, walletId: string): Promise<this> {
    if (name.length === 0) {
      throw Error("Named wallets must have a non-empty name");
    }
    _checkContextSafety(this.network);
    this.name = name;
    let db = getStorageProvider(networkConfig(this.network).dbName);

    if (db) {
      await db.init();
      let savedWalletRecord = await db.getWallet(name);
      await this.fromId(walletId);
      if (savedWalletRecord) {
        await db.updateWallet(name, walletId);
      } else {
        await db.addWallet(name, walletId);
      }

      await db.close();
      return this;
    } else {
      throw Error(
        "No database was available or configured to store the named wallet.",
      );
    }
  }

  /**
   * The wallet a `named:<network>:<name>[:<database>]` walletId stands for. The database part is
   * accepted only when it is the one of the wallet's network, the only one named() reads.
   */
  protected fromNamedId(name: string, dbName?: string): Promise<this> {
    if (!name) {
      throw new InvalidWalletIdError(
        "Named wallets must have a non-empty name",
        { kind: WalletTypeEnum.Named, reason: "missing-value" },
      );
    }
    const networkDbName = networkConfig(this.network).dbName;
    if (dbName && dbName !== networkDbName) {
      throw new InvalidWalletIdError(
        `a named walletId of a ${this.network} wallet can only name the database ${networkDbName}`,
        { kind: WalletTypeEnum.Named, reason: "database" },
      );
    }
    return this.named(name);
  }

  protected async initialize(): Promise<this> {
    return this;
  }

  //#region Serialization
  /**
   * toDbString - store the serialized version of the wallet in the database, not just the name
   *
   * @throws {Error} if called on BaseWallet
   */
  public toDbString(): string {
    return `${this.walletType}:${this.network}:${this.getDepositAddress()}`;
  }
  //#endregion Serialization

  /**
   * named - get a named wallet from the database of the class's network, or create and store a
   * new random one under that name
   *
   * @param name   user friendly wallet alias
   * @param options   the wallet's provider
   *
   * @returns instantiated wallet
   */
  public static async named<T extends typeof BaseWallet>(
    this: T,
    name: string,
    options?: WalletFactoryOptions,
  ): Promise<InstanceType<T>> {
    return this.create(options).named(name) as Promise<InstanceType<T>>;
  }

  /**
   * replaceNamed - replace (recover) named wallet with a new walletId
   *
   * If wallet with a provided name does not exist yet, it will be created with a `walletId` supplied
   * If wallet exists it will be overwritten without exception
   *
   * @param name   user friendly wallet alias
   * @param walletId walletId options to steer the creation process
   * @param options   the wallet's provider
   *
   * @returns instantiated wallet, stored in the database of the class's network
   */
  public static async replaceNamed<T extends typeof BaseWallet>(
    this: T,
    name: string,
    walletId: string,
    options?: WalletFactoryOptions,
  ): Promise<InstanceType<T>> {
    return this.create(options).replaceNamed(name, walletId) as Promise<
      InstanceType<T>
    >;
  }

  protected fromId(_walletId: string): Promise<this> {
    throw Error("fromId not implemented in BaseWallet");
  }

  //#region Funds
  /**
   * utxos Get unspent outputs for the wallet
   *
   */
  public async getUtxos(): Promise<Utxo[]> {
    throw Error("getUtxos not implemented in BaseWallet");
  }

  // Gets balance by summing value in all utxos in sats
  // Balance includes DUST utxos which could be slp tokens and also cashtokens with BCH amounts
  public async getBalance(): Promise<bigint> {
    throw Error("getBalance not implemented in BaseWallet");
  }

  /**
   * Subscribe through the wallet's provider. The subscription follows the wallet to a new
   * provider on setProvider() and ends on stop() or when the returned function is called.
   */
  protected async subscribe(
    subscribe: (provider: ElectrumNetworkProvider) => Promise<CancelFn>,
  ): Promise<CancelFn> {
    const stops = this.stops;
    let provider = this.provider;
    const subscription = {
      subscribe,
      provider,
      cancel: once(await subscribe(provider)),
    };
    // setProvider ran while subscribing
    while (provider !== this.provider && stops === this.stops) {
      await subscription.cancel();
      provider = this.provider;
      subscription.provider = provider;
      subscription.cancel = once(await subscribe(provider));
    }
    if (stops !== this.stops) {
      await subscription.cancel();
      return subscription.cancel;
    }
    this.subscriptions.add(subscription);
    return async () => {
      if (this.subscriptions.delete(subscription)) {
        await subscription.cancel();
      }
    };
  }

  /**
   * Switch the wallet to another electrum provider of the same network: its subscriptions (an
   * HD wallet's address discovery included) are made again on the new provider and ended on
   * the old one, and deliver the new server's current state as they start. The old provider is
   * left connected, as other wallets may still use it: once this resolves, the caller disconnects
   * it (`provider.disconnect()`) if nothing else uses it. Each moved status watch fires again, so a
   * balance callback may get an unchanged value. If the new provider cannot connect or a
   * subscription cannot be made there, the wallet stays on the old provider and this rejects; if
   * the old provider fails as well while moving them back, some subscriptions stay on the new one
   * until setProvider is called again.
   */
  public async setProvider(provider: ElectrumNetworkProvider): Promise<void> {
    checkProviderNetwork(provider, this.network);
    const move = this.providerSwitch.then(() =>
      this.moveSubscriptions(provider),
    );
    this.providerSwitch = move.catch(() => {});
    await move;
  }

  private async moveSubscriptions(provider: ElectrumNetworkProvider) {
    // an unreachable server rejects here, before anything moved
    await provider.connect();
    // not the getter, which would create the global provider for a wallet made with `new`
    const previous = this._provider;
    this._provider = provider;
    try {
      await this.settleSubscriptions();
    } catch (error) {
      this._provider = previous;
      // what did move is left on the new provider if this fails, and a later switch moves it
      await this.settleSubscriptions().catch(() => {});
      throw error;
    }
  }

  // Make every subscription live on the current provider, starting the new one before ending the old
  private async settleSubscriptions() {
    const provider = this.provider;
    const stale = [...this.subscriptions].filter(
      (subscription) => subscription.provider !== provider,
    );
    // an HD wallet holds a subscription per watched address, so they move a bounded number at a time
    const limiter = new Limiter(MOVE_CONCURRENCY);
    const results = await Promise.allSettled(
      stale.map((subscription) =>
        limiter.run(async () => {
          const cancel = once(await subscription.subscribe(provider));
          const cancelPrevious = subscription.cancel;
          subscription.cancel = cancel;
          subscription.provider = provider;
          await cancelPrevious();
          // cancelled while moving
          if (!this.subscriptions.has(subscription)) {
            await cancel();
          }
        }),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  /**
   * Stop all active subscriptions on this wallet, also those still being made
   */
  public async stop(): Promise<void> {
    this.stops++;
    const subscriptions = [...this.subscriptions];
    this.subscriptions.clear();
    await Promise.all(subscriptions.map((s) => s.cancel()));
  }

  /**
   * Watch wallet for any activity (status changes)
   * This is the foundation for watchWalletBalance and watchWalletTransactions
   * @param callback - Called when  the wallet has a status change; its errors go to console.error
   * @returns Cancel function to stop watching
   */
  protected async watchStatus(
    callback: (status: string | null, address: string) => unknown,
    // an HD wallet's `immediate` skips its debounce and discovery wait; one address has neither
    _options: { immediate?: boolean } = {},
  ): Promise<CancelFn> {
    return this.subscribe((provider) =>
      provider.watchAddressStatus(this.getDepositAddress(), (status) =>
        runCallback(() => callback(status, this.getDepositAddress())),
      ),
    );
  }

  /**
   * No-op for single-address wallets. HDWallet overrides this to wait for its per-branch
   * `indices` to advance.
   */
  protected async waitForUpdate(
    _options: {
      indices?: Record<number, number>;
      timeout?: number;
    } = {},
  ): Promise<void> {}

  // sets up a callback to be called upon wallet's balance change
  // can be cancelled by calling the function returned from this one
  // a failed balance read goes to console.error, as the callback's own errors do
  public async watchBalance(
    callback: (balance: bigint) => unknown,
  ): Promise<CancelFn> {
    return this.watchStatus(async () => {
      const balance = await this.getBalance();
      await callback(balance);
    });
  }

  /**
   * Watch wallet for new transactions. Transactions already in the history
   * when the watch starts are not reported; each new one is reported once.
   * @param callback - Called with new transaction hashes when they appear; its errors, and a
   * failed history read, go to console.error
   * @returns Cancel function to stop watching
   */
  protected async watchTransactionHashes(
    callback: (txHash: string) => unknown,
  ): Promise<CancelFn> {
    // Seeded before subscribing so the history at setup is not reported as new
    const existing = await this.getRawHistory();
    const seenTxHashes = new Set<string>();
    let topHeight = 0;
    for (const tx of existing) {
      seenTxHashes.add(tx.tx_hash);
      if (tx.height > topHeight) {
        topHeight = tx.height;
      }
    }

    return this.watchStatus(async () => {
      const history = (await this.getRawHistory(topHeight)).sort((a, b) =>
        a.height <= 0 || b.height <= 0 ? -1 : b.height - a.height,
      );

      const newTxHashes: string[] = [];

      for (const tx of history) {
        if (tx.height > topHeight) {
          topHeight = tx.height;
        }

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

  /**
   * Watch wallet for new transactions
   * @param callback - Called with each new transaction; its errors, and a failed read of the
   * transaction or the history, go to console.error
   * @returns Cancel function to stop watching
   */
  protected async watchTransactions(
    callback: (transaction: ElectrumRawTransaction) => unknown,
  ): Promise<CancelFn> {
    return this.watchTransactionHashes(async (txHash: string) => {
      const tx = await this.provider.getRawTransactionObject(txHash);
      await callback(tx);
    });
  }

  /**
   * Watch wallet for new transactions with token outputs
   * @param callback - Called with each new transaction that has a token output; its errors, and a
   * failed read of the transaction or the history, go to console.error
   * @returns Cancel function to stop watching
   */
  public async watchTokenTransactions(
    callback: (tx: ElectrumRawTransaction) => unknown,
  ): Promise<CancelFn> {
    return this.watchTransactions(
      async (transaction: ElectrumRawTransaction) => {
        if (transaction.vout.some((val) => val.tokenData)) {
          await callback(transaction);
        }
      },
    );
  }

  /**
   * The coins a spend may use: the wallet's current coins, narrowed to `utxoIds` when given (in
   * their order), their token coins narrowed to `tokenUtxoIds` when given, minus `excludeUtxoIds`
   * and the coins on `excludeAddresses`; and `ensureUtxos` resolved to coins of that pool.
   * Coins are compared by outpoint, the txid in either case, so a caller's copy of a coin stands
   * for the wallet's. The token operations pick their inputs themselves and do not spend
   * `ensureUtxos`, but a coin named there outside the pool is refused for them too.
   */
  protected async getSpendPool(
    options?: SendRequestOptionsI,
  ): Promise<{ pool: Utxo[]; ensureUtxos: Utxo[] }> {
    // an id the wallet does not hold is a reservation that outlived its coin and is ignored, but
    // one that cannot be an outpoint is a mistake, and ignoring it would spend the coin it names
    const toListedOutpoint =
      (field: "excludeUtxoIds" | "tokenUtxoIds") => (utxoId: Utxo | string) => {
        let txid: unknown;
        let vout: unknown;
        if (typeof utxoId !== "string") {
          ({ txid, vout } = utxoId);
        } else if (/^[0-9a-f]{64}:\d+(:\d+)?$/i.test(utxoId)) {
          ({ txid, vout } = fromUtxoId(utxoId));
        }
        if (
          typeof txid !== "string" ||
          !/^[0-9a-f]{64}$/i.test(txid) ||
          typeof vout !== "number" ||
          !Number.isSafeInteger(vout) ||
          vout < 0
        ) {
          throw new InvalidRequestError(
            `An ${field} entry is not a txid:vout outpoint`,
            { field, value: utxoId },
          );
        }
        return toOutpoint({ txid, vout });
      };
    const excluded = new Set(
      (options?.excludeUtxoIds ?? []).map(toListedOutpoint("excludeUtxoIds")),
    );
    // An address is compared by its locking bytecode, so its token-aware and plain forms are one.
    // One that does not decode is a mistake, and ignoring it would spend the coins it names.
    const lockingBytecodeOf = (address: string) => {
      const decoded = cashAddressToLockingBytecode(address);
      if (typeof decoded === "string") return undefined;
      return binToHex(decoded.bytecode);
    };
    const excludedBytecodes = new Set(
      (options?.excludeAddresses ?? []).map((address) => {
        const bytecode =
          typeof address === "string" ? lockingBytecodeOf(address) : undefined;
        if (bytecode === undefined) {
          throw new InvalidRequestError(
            "An excludeAddresses entry is not a cash address",
            { field: "excludeAddresses", value: address },
          );
        }
        return bytecode;
      }),
    );
    // checked against the coins held now, so one that arrived since the caller looked is out too
    const onExcludedAddress = (utxo: Utxo) =>
      excludedBytecodes.size > 0 &&
      excludedBytecodes.has(lockingBytecodeOf(utxo.address) ?? "");
    let tokenAllowed: Set<string> | undefined;
    if (options?.tokenUtxoIds) {
      tokenAllowed = new Set(
        options.tokenUtxoIds.map(toListedOutpoint("tokenUtxoIds")),
      );
    }

    const walletUtxos = await this.getUtxos();
    let pool = walletUtxos;
    if (options?.utxoIds) {
      pool = checkUtxos(
        options.utxoIds.map((utxoId: Utxo | string) =>
          typeof utxoId === "string" ? fromUtxoId(utxoId) : utxoId,
        ),
        walletUtxos,
      );
    }
    // a coin listed twice is one coin: the first listing keeps its place in the caller's order
    const seen = new Set<string>();
    pool = pool.filter((utxo) => {
      const utxoId = toOutpoint(utxo);
      if (excluded.has(utxoId) || seen.has(utxoId)) return false;
      if (onExcludedAddress(utxo)) return false;
      if (utxo.token && tokenAllowed && !tokenAllowed.has(utxoId)) return false;
      seen.add(utxoId);
      return true;
    });

    const poolMap = new Map(pool.map((utxo) => [toOutpoint(utxo), utxo]));
    const walletIds = new Set(walletUtxos.map(toOutpoint));
    const ensureUtxos = (options?.ensureUtxos ?? []).map((utxo) => {
      const utxoId = toOutpoint(utxo);
      const inPool = poolMap.get(utxoId);
      if (inPool) return inPool;
      if (excluded.has(utxoId)) {
        throw new UtxoNotAvailableError(
          `Utxo ${utxoId} in ensureUtxos is excluded by excludeUtxoIds`,
          { utxoId, reason: "excluded" },
        );
      }
      const held = walletUtxos.find((val) => toOutpoint(val) === utxoId);
      if (held && onExcludedAddress(held)) {
        throw new UtxoNotAvailableError(
          `Utxo ${utxoId} in ensureUtxos is on an address in excludeAddresses`,
          { utxoId, reason: "excluded" },
        );
      }
      if (!walletIds.has(utxoId)) {
        throw new UtxoNotAvailableError(
          `Utxo ${utxoId} in ensureUtxos not found in wallet`,
          { utxoId, reason: "not-found" },
        );
      }
      if (tokenAllowed && !tokenAllowed.has(utxoId)) {
        throw new UtxoNotAvailableError(
          `Utxo ${utxoId} in ensureUtxos is not among tokenUtxoIds`,
          { utxoId, reason: "not-in-tokenUtxoIds" },
        );
      }
      throw new UtxoNotAvailableError(
        `Utxo ${utxoId} in ensureUtxos is not among utxoIds`,
        { utxoId, reason: "not-in-utxoIds" },
      );
    });

    return { pool, ensureUtxos };
  }

  protected async _getMaxAmountToSend(options?: SendRequestOptionsI): Promise<{
    value: bigint;
    fee: bigint;
    utxos: Utxo[];
    ensureUtxos: Utxo[];
    tokenUtxos: Utxo[];
  }> {
    // get inputs
    const { pool, ensureUtxos } = await this.getSpendPool(options);
    // A plain max send has no token outputs to return a token coin's tokens on, so it leaves
    // token coins out, listed in utxoIds or not; one it is told to spend it refuses
    const tokenCoin = ensureUtxos.find((utxo) => utxo.token);
    if (tokenCoin && !options?.sweepTokenSatoshis) {
      throw new InvalidRequestError(
        `Utxo ${toUtxoId(tokenCoin)} in ensureUtxos holds tokens, which a max send only spends with sweepTokenSatoshis`,
        { field: "ensureUtxos", value: toUtxoId(tokenCoin) },
      );
    }
    const utxos = pool.filter((utxo) => !utxo.token);

    // the one output of a sendMax
    const sendRequests = [
      new SendRequest({ cashaddr: placeholderP2sh32Addr, value: 100n }),
    ];

    const fundingUtxos = await getSuitableUtxos(utxos, undefined, sendRequests);
    const relayFeePerByteInSatoshi = await getRelayFeeCache(this.provider);

    // A token coin is swept when its satoshis above its dust limit pay for more than spending it
    // and recreating its output, both priced by the estimate the max itself is priced with, or
    // when ensureUtxos names it
    const tokenUtxos: Utxo[] = [];
    const tokenReturns: TokenSendRequest[] = [];
    if (options?.sweepTokenSatoshis) {
      const placeholderTokenAddr = toTokenaddr(placeholderCashAddr);
      const estimate = (coins: Utxo[], requests: TokenSendRequest[]) =>
        getFeeAmountWithoutChange({
          utxos: coins,
          sendRequests: requests,
          relayFeePerByteInSatoshi,
        });
      const overhead = await estimate([], []);
      const ensured = new Set(ensureUtxos.map(toUtxoId));
      for (const coin of pool.filter((utxo) => utxo.token)) {
        const tokenReturn = sweptTokenReturn(coin, placeholderTokenAddr);
        const cost = (await estimate([coin], [tokenReturn])) - overhead;
        if (
          ensured.has(toUtxoId(coin)) ||
          coin.satoshis - tokenReturn.value! > cost
        ) {
          tokenUtxos.push(coin);
          tokenReturns.push(tokenReturn);
        }
      }
    }

    const fee = await getFeeAmountWithoutChange({
      utxos: [...fundingUtxos, ...tokenUtxos],
      sendRequests: [...sendRequests, ...tokenReturns],
      relayFeePerByteInSatoshi: relayFeePerByteInSatoshi,
    });
    const spendableAmount =
      sumUtxoValue(fundingUtxos) +
      sumUtxoValue(tokenUtxos) -
      tokenReturns.reduce((sum, request) => sum + request.value!, 0n);

    let result = spendableAmount - fee;
    if (result < 0n) {
      result = 0n;
    }

    return {
      value: result,
      fee,
      utxos: fundingUtxos,
      // the token coins it names are among tokenUtxos
      ensureUtxos: ensureUtxos.filter((utxo) => !utxo.token),
      tokenUtxos,
    };
  }

  /**
   * The amount a `sendMax` with these options sends: the BCH coins of the pool minus the fee of
   * spending them all to one output, plus with `sweepTokenSatoshis` what the token coins worth
   * sweeping hold above their dust limit. The fee is that of the largest standard output, a
   * P2SH32 one, so the max is enough for any destination and leaves 10 bytes' fee over for a
   * P2PKH one; a `send` of it spends every coin and leaves that to the miners.
   */
  public async getMaxAmountToSend(
    options?: SendRequestOptionsI,
  ): Promise<bigint> {
    const { value: result } = await this._getMaxAmountToSend(options);

    return result;
  }

  /**
   * send Send some amount to an address
   * this function processes the send requests, encodes the transaction, sends it to the network
   * @returns the transaction id, the signed transaction and the token categories it spends or sends
   */
  public async send(
    requests:
      | SendRequest
      | TokenSendRequest
      | OpReturnData
      | Array<SendRequest | TokenSendRequest | OpReturnData>,
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    const { encodedTransaction, categories } = await this.encodeTransaction(
      requests,
      undefined,
      options,
    );
    return this._send(encodedTransaction, categories, options);
  }

  /**
   * sendMax Send all available funds to a destination cash address. Refuses with
   * InsufficientFundsError when the max, the fee taken off, is below the dust limit of the
   * destination's locking bytecode.
   *
   * @param  {string} cashaddr destination cash address
   * @param  {SendRequestOptionsI} options Options of the send requests
   *
   * @returns the transaction id, the signed transaction and the token categories it spends or sends
   */
  public async sendMax(
    cashaddr: string,
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    return await this.sendMaxRaw(cashaddr, options);
  }

  /**
   * sendMaxRaw (internal) Send all available funds to a destination cash address
   *
   * @param  {string} cashaddr destination cash address
   * @param  {SendRequestOptionsI} options Options of the send requests
   *
   * @returns the transaction id sent to the network
   */
  protected async sendMaxRaw(
    cashaddr: string,
    options?: SendRequestOptionsI,
    privateKey?: Uint8Array,
  ): Promise<SendResponse> {
    if (!privateKey) this.assertCanSign();
    const {
      value: maxSpendableAmount,
      fee,
      utxos,
      ensureUtxos,
      tokenUtxos,
    } = await this._getMaxAmountToSend(options);

    // an output below its dust limit is refused by the network, so not built at all
    const dustLimit = getDustThreshold({
      lockingBytecode: deriveLockscript(cashaddr),
      valueSatoshis: maxSpendableAmount,
    });
    if (maxSpendableAmount < dustLimit) {
      const available = sumUtxoValue(utxos);
      throw amountNotMetError(fee + dustLimit, available);
    }

    // pinned as well: the selection would stop at the coins that cover the amount, leaving the
    // ones worth less than their own input fee unspent and their share of the fee to the miners.
    // The caller's ensureUtxos, all BCH coins of the pool and so among them, go first as in send.
    const ensureIds = new Set(ensureUtxos.map(toUtxoId));
    const inputs = [
      ...ensureUtxos,
      ...utxos.filter((utxo) => !ensureIds.has(toUtxoId(utxo))),
      ...tokenUtxos,
    ];
    options = { ...options, utxoIds: inputs, ensureUtxos: inputs };

    const sendRequest = new SendRequest({
      cashaddr: cashaddr,
      value: maxSpendableAmount,
    });
    // each swept coin's tokens come back on a change address of its own
    const changeAddresses = this.planChangeAddresses();
    const tokenReturns = tokenUtxos.map((coin) =>
      sweptTokenReturn(coin, changeAddresses.token()),
    );

    const { encodedTransaction, categories } = await this.encodeTransaction(
      [sendRequest, ...tokenReturns],
      true,
      options,
      privateKey,
    );
    return this._send(encodedTransaction, categories, options);
  }

  protected async _send(
    encodedTransaction: Uint8Array,
    categories: string[],
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    const transaction = binToHex(encodedTransaction);
    if (options?.broadcast === false) {
      const txId = binToHex(
        sha256.hash(sha256.hash(encodedTransaction)).reverse(),
      );
      return { txId, transaction, categories };
    }

    const txId = await this.submitTransaction(encodedTransaction);
    return { txId, transaction, categories };
  }

  // A token operation's send: the burns the operation allows reach the token conservation check.
  // They are a parameter, not an option, so that no options object can allow a burn on a send.
  protected async sendTokenOperation(
    requests: Array<SendRequest | TokenSendRequest | OpReturnData>,
    options: SendRequestOptionsI,
    tokenBurns: TokenBurnAllowance | undefined,
  ): Promise<SendResponse> {
    const { encodedTransaction, categories } = await this.encodeTransaction(
      requests,
      undefined,
      options,
      undefined,
      tokenBurns,
    );
    return this._send(encodedTransaction, categories, options);
  }

  /** Whether the wallet holds the keys to sign its own coins' inputs. */
  protected canSign(): boolean {
    return false;
  }

  // Every spend asks first, so that a watch-only wallet is refused before it reads or builds
  // anything; the placeholder key the builder falls back on only sizes fee estimates
  private assertCanSign(): void {
    if (!this.canSign()) {
      throw new WatchOnlyError(
        "A watch-only wallet cannot sign: it holds no private key",
      );
    }
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
    tokenBurns?: TokenBurnAllowance,
  ) {
    if (!privateKey) this.assertCanSign();
    let sendRequests = asSendRequestObject(requests);

    let checkTokenQuantities: boolean = true;
    if (options?.checkTokenQuantities === false) {
      checkTokenQuantities = false;
    }
    // A send burns no token, checkTokenQuantities or not: that option turns off the token input
    // matching and change, never the conservation check. Only a token operation says what it may
    // burn, and tokenBurn alone allows any.
    if (!tokenBurns) {
      tokenBurns = {};
    }

    const spendPool = await this.getSpendPool(options);
    let utxos = spendPool.pool;
    // the pool's copies: every coin the send spends comes from the pool
    options = { ...options, ensureUtxos: spendPool.ensureUtxos };

    // filter out token utxos if there are no token requests
    if (
      checkTokenQuantities &&
      !sendRequests.some((val) => val instanceof TokenSendRequest)
    ) {
      utxos = utxos.filter((val) => !val.token);
    }

    if (utxos.length === 0) {
      throw new InsufficientFundsError("There were no Unspent Outputs", {
        asset: "bch",
      });
    }

    // The token inputs are chosen here and pinned through ensureUtxos: the inputs of the NFT
    // requests as the selection's token matching finds them, then only the fungible coins the
    // requested amounts need (mainnet-js#246). The token change is derived from exactly these
    // inputs, and the selection below gets the requests without the change and without the
    // fungible-only ones, so that it cannot pull in other token coins.
    const requestedOutputs = [...sendRequests];
    let selectionRequests = requestedOutputs;
    let tokenInputs: Utxo[] = [];
    let tokenChange: TokenSendRequest[] = [];
    let changeAddresses = this.planChangeAddresses();
    if (checkTokenQuantities) {
      const tokenRequests = requestedOutputs.filter(
        (val) => val instanceof TokenSendRequest,
      );
      selectionRequests = requestedOutputs.filter(
        (val) =>
          !(val instanceof TokenSendRequest) ||
          val.nft?.capability !== undefined ||
          val.nft?.commitment !== undefined,
      );
      const pinned = await getSuitableUtxos(
        utxos,
        0n,
        selectionRequests,
        options?.ensureUtxos || [],
        options?.tokenOperation,
      );
      const fungibleInputs = selectFungibleTokenUtxos(
        utxos,
        pinned,
        tokenRequests,
      );
      // a copy: the caller's options stay as they were, e.g. for a retry
      options = { ...options, ensureUtxos: [...pinned, ...fungibleInputs] };
      tokenInputs = options.ensureUtxos!.filter((val) => val.token);
      changeAddresses = this.planChangeAddresses();
      tokenChange = getTokenChangeRequests(
        tokenInputs,
        tokenRequests,
        changeAddresses.token,
      );
    }
    const allOutputs = [...sendRequests, ...tokenChange];

    const spendAmount = await sumSendRequestAmounts(allOutputs);

    if (typeof spendAmount !== "bigint") {
      throw Error("Couldn't get spend amount when building transaction");
    }

    // The fee is estimated from the coins the selection picks, not from every candidate: sizing
    // the whole pool made token operations fund an input for each token coin of the wallet, and
    // plain sends over-select (mainnet-js#253).
    const relayFeePerByteInSatoshi = await getRelayFeeCache(this.provider);
    const ensureUtxos = options?.ensureUtxos || [];
    // a send without change, a max send, is estimated as its max was
    const estimateFee = (inputs: Utxo[]) =>
      discardChange
        ? getFeeAmountWithoutChange({
            utxos: inputs,
            sendRequests: allOutputs,
            relayFeePerByteInSatoshi,
          })
        : getFeeAmountSimple({
            utxos: inputs,
            sendRequests: allOutputs,
            sourceAddress: this.getDepositAddress(),
            relayFeePerByteInSatoshi: relayFeePerByteInSatoshi,
          });
    // Each round selects for the last round's estimate plus `margin` until the selected coins
    // cover their own fee, the precise one included; the estimate only grows.
    const settle = async (margin: bigint, feeEstimate: bigint) => {
      for (let round = 0; ; round++) {
        const selectedUtxos = await getSuitableUtxos(
          utxos,
          spendAmount + feeEstimate + margin,
          selectionRequests,
          ensureUtxos,
          options?.tokenOperation,
        );
        if (selectedUtxos.length === 0) {
          throw new InsufficientFundsError(
            "The available inputs couldn't satisfy the request with fees",
            { asset: "bch" },
          );
        }
        let feeNeeded = await estimateFee(selectedUtxos);
        if (feeNeeded <= feeEstimate) {
          const fee = await getFeeAmount({
            utxos: selectedUtxos,
            sendRequests: sendRequests,
            sourceAddress: this.getDepositAddress(),
            relayFeePerByteInSatoshi: relayFeePerByteInSatoshi,
            discardChange,
            walletCache: this.walletCache,
            tokenChange,
          });
          if (fee <= feeEstimate) return { selectedUtxos, fee };
          feeNeeded = fee;
        }
        // a guard: the estimate only grows, and each round can only add coins
        if (round > utxos.length) {
          throw new Error("The fee estimate did not settle on a set of inputs");
        }
        feeEstimate = feeNeeded;
      }
    };
    const initialEstimate = await estimateFee(ensureUtxos);
    let settled: Awaited<ReturnType<typeof settle>>;
    try {
      settled = await settle(0n, initialEstimate);
    } catch (e) {
      const shortfall: { required: bigint; available: bigint } | undefined =
        e instanceof InsufficientFundsError ? e["data"] : undefined;
      if (!shortfall) throw e;
      const pinnedIds = new Set(ensureUtxos.map(toUtxoId));
      const usable = [
        ...ensureUtxos,
        ...utxos.filter((val) => !val.token && !pinnedIds.has(toUtxoId(val))),
      ];
      // A send of every usable coin, as of the amount getMaxAmountToSend gives, fits without
      // change where the estimate, which prices a change output, does not; change at or below
      // dust is not built, as below
      let leftover = -1n;
      let feeWithoutChange = 0n;
      if (sumUtxoValue(usable) > spendAmount) {
        feeWithoutChange = await getFeeAmount({
          utxos: usable,
          sendRequests,
          sourceAddress: this.getDepositAddress(),
          relayFeePerByteInSatoshi,
          discardChange: true,
          walletCache: this.walletCache,
          tokenChange,
        });
        leftover = sumUtxoValue(usable) - spendAmount - feeWithoutChange;
      }
      if (leftover < 0n || leftover > DUST_UTXO_THRESHOLD) {
        // The last round's estimate leaves out the fee of the coins the selection could not
        // reach; what is needed is told from the fee of spending every coin it could use.
        const usableFee = await estimateFee(usable);
        let required = spendAmount + usableFee;
        if (shortfall.required > required) required = shortfall.required;
        throw amountNotMetError(required, shortfall.available);
      }
      settled = { selectedUtxos: usable, fee: feeWithoutChange };
    }
    // Change at or below dust is not built and goes to the miners. Selecting for change above
    // dust is kept when it pays the miners less, the extra inputs' fees included.
    const change =
      sumUtxoValue(settled.selectedUtxos) - spendAmount - settled.fee;
    if (!discardChange && change > 0n && change <= DUST_UTXO_THRESHOLD) {
      try {
        const withChange = await settle(DUST_UTXO_THRESHOLD + 1n, settled.fee);
        if (withChange.fee < settled.fee + change) settled = withChange;
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
      }
    }
    const { selectedUtxos, fee } = settled;
    // a token coin the change was not computed from would be burned
    const tokenInputIds = new Set(tokenInputs.map(toUtxoId));
    if (
      checkTokenQuantities &&
      selectedUtxos.some(
        (val) => val.token && !tokenInputIds.has(toUtxoId(val)),
      )
    ) {
      throw new Error(
        "Token selection picked a coin the change does not cover",
      );
    }
    const encodedTransaction = await buildEncodedTransaction({
      inputs: selectedUtxos,
      outputs: sendRequests,
      signingKey: privateKey ?? placeholderPrivateKeyBin,
      fee,
      discardChange,
      changeAddress: changeAddresses.bch,
      walletCache: this.walletCache,
      tokenBurns,
      tokenChange,
    });

    const categories = [
      ...selectedUtxos
        .filter((val) => val.token?.category)
        .map((val) => val.token!.category),
      ...sendRequests
        .filter((val) => val instanceof TokenSendRequest)
        .map((val) => (val as TokenSendRequest).category),
    ].filter((value, index, array) => array.indexOf(value) === index);

    return { encodedTransaction, categories };
  }

  /**
   * Broadcast a signed transaction and wait until the server reports it, and then until the
   * wallet's own coins reflect it (its inputs gone, its outputs to the wallet there), so that the
   * next spend does not pick a coin it spent. That second wait gives up after 10 seconds.
   * @throws {BroadcastRejectedError} If the server refused the transaction.
   * @returns The transaction id.
   */
  public async submitTransaction(transaction: Uint8Array): Promise<string> {
    if (!this.provider) {
      throw Error("Wallet network provider was not initialized");
    }
    const rawTransaction = binToHex(transaction);
    const txId = await this.provider.sendRawTransaction(rawTransaction);
    await this.waitForCoins(transaction, txId);
    return txId;
  }

  // The coins a send's wait reads, without waiting on anything else
  protected async coinsNow(): Promise<Utxo[]> {
    return this.getUtxos();
  }

  // Waits until the wallet's coins reflect a transaction the server holds: the status that
  // includes it may arrive after the broadcast returns, and other statuses before it. Never
  // throws, the transaction went through; a view that stays stale only risks a refused next spend
  private async waitForCoins(
    transaction: Uint8Array,
    txId: string,
  ): Promise<void> {
    const decoded = decodeTransaction(transaction);
    if (typeof decoded === "string") return;
    const spent = decoded.inputs.map((input) =>
      toUtxoId({
        txid: binToHex(input.outpointTransactionHash),
        vout: input.outpointIndex,
      }),
    );
    const own = decoded.outputs.flatMap((output, vout) => {
      const result = lockingBytecodeToCashAddress({
        bytecode: output.lockingBytecode,
        prefix: this.networkPrefix,
      });
      if (typeof result === "string") return [];
      if (!this.watchesAddress(result.address)) return [];
      return [toUtxoId({ txid: txId, vout })];
    });
    const reflected = async () => {
      const ids = new Set((await this.coinsNow()).map(toUtxoId));
      return own.every((id) => ids.has(id)) && !spent.some((id) => ids.has(id));
    };

    let done = false;
    let woken = false;
    let wake = () => {};
    let cancel: CancelFn | undefined;
    const wait = (async () => {
      // each status is read at once: the wait is for this transaction, not a quiet moment, on
      // addresses already watched, so not for a discovery under way either
      const made = await this.watchStatus(
        () => {
          woken = true;
          wake();
        },
        { immediate: true },
      );
      if (done) {
        await made();
        return;
      }
      cancel = made;
      while (!done) {
        woken = false;
        if (await reflected()) return;
        // a status handled during the read is read again at once
        if (!woken) await new Promise<void>((resolve) => (wake = resolve));
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, COIN_VIEW_TIMEOUT);
    });
    try {
      await Promise.race([wait, expired]);
    } catch {
      // a status watch or read that failed: the view is left as it is
    } finally {
      done = true;
      wake();
      clearTimeout(timer);
      wait.catch(() => {});
      await cancel?.().catch(() => {});
    }
  }

  // gets transaction history of this wallet
  public async getRawHistory(_fromHeight: number = 0): Promise<TxI[]> {
    throw Error("getRawHistory not implemented in BaseWallet");
  }

  /**
   * watchBlocks Watch network blocks
   *
   * @param callback callback with a block header object; its errors go to console.error
   * @param skipCurrentHeight if set, the notification about current block will not arrive
   *
   * @returns a function which will cancel watching upon evaluation
   */
  public async watchBlocks(
    callback: (header: HexHeaderI) => unknown,
    skipCurrentHeight: boolean = true,
  ): Promise<CancelFn> {
    // the skip is done here rather than by the provider, so a move to another provider can tell
    // its current tip, delivered on subscribing, from the header already seen
    let skip = skipCurrentHeight;
    let last: HexHeaderI | undefined;
    return this.subscribe((provider) =>
      provider.watchBlocks((header) => {
        const seen = last?.height === header.height && last.hex === header.hex;
        last = header;
        if (skip) {
          skip = false;
          return;
        }
        if (!seen) runCallback(() => callback(header));
      }, false),
    );
  }

  //#endregion Funds

  //#region Cashtokens
  /**
   * Create one or more new cashtokens, fungible and/or non-fungible (NFT), in a single transaction.
   * Each genesis request consumes a distinct unspent output with vout=0; the spent prevout's txid
   * becomes the new token category. They are the first such outputs without tokens in the pool,
   * in its order, so a caller that lists `utxoIds` decides which coin each category comes from.
   * Refer to spec https://github.com/cashtokens/cashtokens
   * @param  {TokenGenesisRequest | TokenGenesisRequest[]} genesisRequests one or more genesis requests.
   *   For each request:
   *   @param  {bigint?} amount amount of *fungible* tokens to create
   *   @param  {object?} nft NFT capability and commitment
   *   @param  {string?} cashaddr destination address; defaults to wallet's token deposit address
   *   @param  {bigint?} value satoshi value to send alongside tokens; defaults to 1000
   * @param  {SendRequestType | SendRequestType[]} sendRequests single or an array of extra send requests (OP_RETURN, value transfer, etc.) to include in genesis transaction;
   *   a token output among them can only carry a category the genesis creates, others are refused with InvalidRequestError
   * @param  {SendRequestOptionsI} options Options of the send requests
   */
  public async tokenGenesis(
    genesisRequests: TokenGenesisRequest | TokenGenesisRequest[],
    sendRequests: SendRequestType | SendRequestType[] = [],
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    this.assertCanSign();
    if (!Array.isArray(genesisRequests)) {
      genesisRequests = [genesisRequests];
    }
    if (genesisRequests.length === 0) {
      throw new Error("tokenGenesis requires at least one request");
    }
    genesisRequests.forEach(checkGenesisRequest);
    const extraRequests = asSendRequestObject(
      sendRequests as Parameters<typeof asSendRequestObject>[0],
    );

    const { pool: utxos } = await this.getSpendPool(options);

    const genesisInputs = utxos.filter((val) => val.vout === 0 && !val.token);
    if (genesisInputs.length < genesisRequests.length) {
      throw new InsufficientFundsError(
        `Not enough vout=0 inputs available for new token genesis: need ${genesisRequests.length}, have ${genesisInputs.length}`,
        { asset: "bch" },
      );
    }

    const pinnedInputs = genesisInputs.slice(0, genesisRequests.length);
    // a genesis selects no token coins, so an extra output can only carry a new category
    const newCategories = pinnedInputs.map((val) => val.txid.toLowerCase());
    for (const request of extraRequests) {
      if (
        request instanceof TokenSendRequest &&
        !newCategories.includes(request.category)
      ) {
        throw new InvalidRequestError(
          `A token genesis can only send the categories it creates, not ${request.category}`,
          { field: "sendRequests", value: request.category },
        );
      }
    }
    const depositAddresses = this.getTokenDepositAddresses(
      genesisRequests.filter((request) => !request.cashaddr).length,
    );
    const genesisSendRequests = genesisRequests.map(
      (request, i) =>
        new TokenSendRequest({
          cashaddr: request.cashaddr || depositAddresses.shift()!,
          amount: request.amount,
          value: request.value,
          nft: request.nft,
          category: pinnedInputs[i].txid,
        }),
    );

    return this.sendTokenOperation(
      [...genesisSendRequests, ...extraRequests],
      {
        ...options,
        utxoIds: utxos,
        ensureUtxos: pinnedInputs,
        checkTokenQuantities: false,
        tokenOperation: "genesis",
      },
      {},
    );
  }

  /**
   * Mint new NFT cashtokens using existing minting tokens. Supports minting across
   * multiple categories in a single transaction; each request specifies its own category.
   * Every request creates one output, and the library caps neither the number of requests nor
   * the outputs they add up to: limit them yourself if they come from untrusted input.
   * Refer to spec https://github.com/cashtokens/cashtokens
   * @param  {TokenMintRequest | TokenMintRequest[]} mintRequests mint requests with new token properties and recipients
   *   For each request:
   *   @param  {string} category category of the minting NFT to spend; required
   *   @param  {object?} nft NFT capability and commitment of the new token
   *   @param  {string?} cashaddr destination address; defaults to wallet's token deposit address
   *   @param  {bigint?} value satoshi value to send alongside tokens; defaults to 1000
   * @param  {SendRequestOptionsI} options Options of the send requests
   */
  public async tokenMint(
    mintRequests: TokenMintRequest | Array<TokenMintRequest>,
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    this.assertCanSign();
    if (!Array.isArray(mintRequests)) {
      mintRequests = [mintRequests];
    }
    if (mintRequests.length === 0) {
      throw new Error("tokenMint requires at least one request");
    }

    const requestsByCategory = new Map<string, TokenMintRequest[]>();
    for (const given of mintRequests) {
      // a copy: validated and its category lowercased, the caller's object left as it was
      const request = new TokenMintRequest(given);
      const bucket = requestsByCategory.get(request.category) ?? [];
      bucket.push(request);
      requestsByCategory.set(request.category, bucket);
    }

    const { pool: utxos } = await this.getSpendPool(options);
    const ensureUtxos: Utxo[] = [];
    const outputs: TokenSendRequest[] = [];
    const depositAddresses = this.getTokenDepositAddresses(
      mintRequests.filter((request) => !request.cashaddr).length,
    );
    const changeAddresses = this.planChangeAddresses();

    for (const [category, requests] of requestsByCategory) {
      const nftUtxos = utxos.filter(
        (val) =>
          val.token?.category === category &&
          val.token?.nft?.capability === NFTCapability.minting,
      );
      if (!nftUtxos.length) {
        throw new InsufficientFundsError(
          `You do not have any token UTXOs with minting capability for category ${category}`,
          { asset: "token", category },
        );
      }

      const mintingUtxo = nftUtxos[0];
      ensureUtxos.push(mintingUtxo);
      outputs.push(
        new TokenSendRequest({
          cashaddr: changeAddresses.token(),
          category: category,
          nft: mintingUtxo.token?.nft,
          amount: mintingUtxo.token!.amount,
          value: mintingUtxo.satoshis,
        }),
      );

      for (const request of requests) {
        outputs.push(
          new TokenSendRequest({
            cashaddr: request.cashaddr || depositAddresses.shift()!,
            amount: 0n,
            category: category,
            value: request.value,
            nft: request.nft,
          }),
        );
      }
    }

    return this.sendTokenOperation(
      outputs,
      {
        ...options,
        ensureUtxos,
        checkTokenQuantities: false,
        tokenOperation: "mint",
      },
      {},
    );
  }

  /**
   * Perform an explicit token burning by spending one or more token utxos alongside an OP_RETURN.
   * Multiple burn requests across distinct categories can be bundled into a single transaction.
   *
   * A request burns what it names, and the transaction is checked to burn no more:
   *  * with an NFT and no amount, one coin with that NFT is spent and the NFT destroyed; fungible
   *    tokens that coin carries come back without it
   *  * with an amount, that many fungible tokens are burned from the matching coins: the
   *    fungible-only coins of the category, or with an NFT given, the coins carrying that NFT,
   *    which come back with it. More than those coins carry throws InsufficientFundsError.
   *
   * Refer to spec https://github.com/cashtokens/cashtokens
   * @param  {TokenBurnRequest | TokenBurnRequest[]} burnRequests one or more burn requests.
   *   For each request:
   *   @param  {string} category category of a token to burn
   *   @param  {object?} nft NFT capability and commitment to match, optional
   *   @param  {bigint?} amount amount of fungible tokens to burn, optional
   * @param  {string?} message optional message to include in OP_RETURN
   * @param  {SendRequestOptionsI} options Options of the send requests
   */
  public async tokenBurn(
    burnRequests: TokenBurnRequest | TokenBurnRequest[],
    message?: string,
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    this.assertCanSign();
    if (!Array.isArray(burnRequests)) {
      burnRequests = [burnRequests];
    }
    if (burnRequests.length === 0) {
      throw new Error("tokenBurn requires at least one request");
    }
    // copies: validated and their categories lowercased, the caller's objects left as they were
    burnRequests = burnRequests.map((request) => new TokenBurnRequest(request));

    const { pool: utxos } = await this.getSpendPool(options);
    const ensureUtxos: Utxo[] = [];
    const changeSendRequests: TokenSendRequest[] = [];
    // exactly what the requests burn: an NFT that comes back is not listed
    const tokenBurns: Required<TokenBurnAllowance> = { fungible: {}, nfts: [] };
    const changeAddresses = this.planChangeAddresses();

    // a coin an earlier request spends is not there for the next one
    const spentIds = new Set<string>();
    for (const burnRequest of burnRequests) {
      const { category, nft } = burnRequest;
      const tokenUtxos = utxos.filter(
        (val) =>
          !spentIds.has(toUtxoId(val)) &&
          val.token?.category === category &&
          val.token?.nft?.capability === nft?.capability &&
          val.token?.nft?.commitment === nft?.commitment,
      );

      if (!tokenUtxos.length) {
        throw new InsufficientFundsError(
          `You do not have suitable token UTXOs to perform burn for category ${category}`,
          { asset: "token", category },
        );
      }

      const amount = toTokenAmount(burnRequest.amount);
      if (nft && amount === 0n) {
        // a coin with the NFT alone, when there is one, so that no fungible tokens move
        const coin =
          tokenUtxos.find((val) => val.token!.amount === 0n) ?? tokenUtxos[0];
        ensureUtxos.push(coin);
        spentIds.add(toUtxoId(coin));
        tokenBurns.nfts.push({
          category,
          capability: coin.token!.nft!.capability,
          commitment: coin.token!.nft!.commitment ?? "",
        });
        if (coin.token!.amount > 0n) {
          changeSendRequests.push(
            new TokenSendRequest({
              cashaddr: changeAddresses.token(),
              category,
              amount: coin.token!.amount,
            }),
          );
        }
        continue;
      }

      const available = tokenUtxos.reduce(
        (sum, val) => sum + val.token!.amount,
        0n,
      );
      if (available < amount) {
        throw new InsufficientFundsError(
          `Not enough fungible tokens of category ${category} to burn ${amount}: ${available} available`,
          { asset: "token", category },
        );
      }
      tokenBurns.fungible[category] =
        (tokenBurns.fungible[category] ?? 0n) + amount;

      let toBurn = amount;
      let fungibleChange = 0n;
      for (const coin of tokenUtxos) {
        if (toBurn === 0n) break;
        if (coin.token!.amount === 0n) continue;
        ensureUtxos.push(coin);
        spentIds.add(toUtxoId(coin));
        let burned = coin.token!.amount;
        if (burned > toBurn) burned = toBurn;
        toBurn -= burned;
        const left = coin.token!.amount - burned;
        const coinNft = coin.token!.nft;
        if (coinNft) {
          // the NFT comes back as it was, on the coin's own sats, as a send's NFT change does
          changeSendRequests.push(
            new TokenSendRequest({
              cashaddr: changeAddresses.token(),
              category,
              amount: left,
              nft: {
                capability: coinNft.capability,
                commitment: coinNft.commitment ?? "",
              },
              value: coin.satoshis,
            }),
          );
        } else {
          fungibleChange += left;
        }
      }
      if (fungibleChange > 0n) {
        // no value: the standard 1000 sats of a token output, as a send's fungible change holds;
        // the spent coins' other sats go to the BCH change
        changeSendRequests.push(
          new TokenSendRequest({
            cashaddr: changeAddresses.token(),
            category,
            amount: fungibleChange,
          }),
        );
      }
    }

    const opReturn = OpReturnData.fromString(message || "");
    return this.sendTokenOperation(
      [opReturn, ...changeSendRequests],
      {
        ...options,
        checkTokenQuantities: false,
        ensureUtxos: ensureUtxos.length > 0 ? ensureUtxos : undefined,
        tokenOperation: "burn",
      },
      tokenBurns,
    );
  }

  //#endregion Cashtokens
}

/**
 * _checkContextSafety (internal) if running in nodejs, will disable saving
 * mainnet wallets on public servers if ALLOW_MAINNET_USER_WALLETS is set to false
 * @param network        the network of the wallet to save
 */
export const _checkContextSafety = function (network: Network) {
  if (getRuntimePlatform() === "node") {
    if (process.env.ALLOW_MAINNET_USER_WALLETS === `false`) {
      if (network === NetworkType.Mainnet) {
        throw Error(
          `Refusing to save wallet in an open public database, remove ALLOW_MAINNET_USER_WALLETS="false", if this service is secure and private`,
        );
      }
    }
  }
};

/**
 * getNamedWalletId - get the full wallet id from the database
 *
 * @param name   user friendly wallet alias
 * @param dbName database the wallet is stored in, the mainnet one ("bitcoincash") by default
 *
 * @throws {Error} if no StorageProvider is configured
 * @returns the stored wallet id, or undefined if there is no wallet of that name or its row
 * holds an empty id
 */
export async function getNamedWalletId(
  name: string,
  dbName?: string,
): Promise<string | undefined> {
  if (name.length === 0) {
    throw Error("Named wallets must have a non-empty name");
  }

  dbName = dbName ? dbName : networkConfig(NetworkType.Mainnet).dbName;
  let db = getStorageProvider(dbName);

  if (db) {
    await db.init();
    let savedWalletRecord = await db.getWallet(name);
    await db.close();
    // an empty id names no wallet, as a missing row does
    return savedWalletRecord?.wallet || undefined;
  } else {
    throw Error(
      "No database was available or configured to store the named wallet.",
    );
  }
}

/**
 * namedWalletExists - check whether a named wallet is stored in the database; constructs no
 * wallet and opens no subscription
 *
 * @param name   user friendly wallet alias
 * @param dbName database the wallet is stored in, the mainnet one ("bitcoincash") by default
 *
 * @throws {Error} if no StorageProvider is configured
 * @returns whether a wallet of that name is stored
 */
export async function namedWalletExists(
  name: string,
  dbName?: string,
): Promise<boolean> {
  if (name.length === 0) {
    throw Error("Named wallets must have a non-empty name");
  }

  dbName = dbName ? dbName : networkConfig(NetworkType.Mainnet).dbName;
  const db = getStorageProvider(dbName);
  if (!db) {
    throw Error(
      "No database was available or configured to store the named wallet.",
    );
  }

  await db.init();
  try {
    return await db.walletExists(name);
  } finally {
    await db.close();
  }
}

/**
 * saveNamedWallet - store a wallet id under a name, replacing the id stored under that name if
 * there is one: the row `replaceNamed` writes, without constructing the wallet, so no provider
 * is created and no subscription opened
 *
 * The id is checked for its form (a type a wallet class loads, a known network, a value), not
 * for its key: store ids that `toDbString()` returned, or that a wallet class loaded.
 *
 * @param name   user friendly wallet alias
 * @param walletId the wallet's id, as `toDbString()` returns it
 * @param dbName database to store it in, the one of the id's network ("bitcoincash", "bchtest",
 * "bchreg" or a registered network's) by default; another network's database is refused
 *
 * @throws {InvalidWalletIdError} if the id cannot be read, or if `dbName` is another network's
 * database
 * @throws {Error} if no StorageProvider is configured
 */
export async function saveNamedWallet(
  name: string,
  walletId: string,
  dbName?: string,
): Promise<void> {
  if (name.length === 0) {
    throw Error("Named wallets must have a non-empty name");
  }
  // the check deleteNamedWallet makes: a row it cannot read is one it cannot delete
  walletCacheIdFromWalletId(walletId);
  const network = walletId.split(":")[1];
  const networkDbName = networkConfig(network).dbName;
  const networkDbNames = knownNetworks().map((config) => config.dbName);
  if (dbName && dbName !== networkDbName && networkDbNames.includes(dbName)) {
    throw new InvalidWalletIdError(
      `a ${network} walletId cannot be stored in the database ${dbName}`,
      { kind: walletIdKind(walletId.split(":")[0]), reason: "network" },
    );
  }
  _checkContextSafety(network);

  const db = getStorageProvider(dbName || networkDbName);
  if (!db) {
    throw Error(
      "No database was available or configured to store the named wallet.",
    );
  }

  await db.init();
  try {
    if (await db.getWallet(name)) {
      await db.updateWallet(name, walletId);
    } else {
      await db.addWallet(name, walletId);
    }
  } finally {
    await db.close();
  }
}

/**
 * deleteNamedWallet - delete a named wallet from the database, and its cache record with it
 *
 * `StorageProvider.deleteWallet` removes only the row; the wallet's cache record (its derived
 * private keys and history, see {@link purgeWalletCache}) is removed here too, before the row,
 * and a loaded wallet of that id no longer writes it. That holds in this JavaScript process only:
 * a wallet of that id open in another browser tab can write the record back, which
 * `pruneWalletCaches` at a later start removes. No-op for a missing name.
 *
 * @param name   user friendly wallet alias
 * @param dbName database the wallet is stored in, the mainnet one ("bitcoincash") by default
 *
 * @throws {InvalidWalletIdError} if the row's wallet id cannot be read (e.g. a `named:` alias)
 * @throws {Error} if no StorageProvider is configured, or if the cache record could not be
 * removed; the row is kept in each case
 */
export async function deleteNamedWallet(
  name: string,
  dbName?: string,
): Promise<void> {
  if (name.length === 0) {
    throw Error("Named wallets must have a non-empty name");
  }

  dbName = dbName ? dbName : networkConfig(NetworkType.Mainnet).dbName;
  const db = getStorageProvider(dbName);
  if (!db) {
    throw Error(
      "No database was available or configured to store the named wallet.",
    );
  }

  await db.init();
  try {
    const savedWalletRecord = await db.getWallet(name);
    if (!savedWalletRecord) return;
    // the cache record first: if it cannot be removed, the row that leads to it stays. The row
    // goes before the purge is done, so a wallet opened from it meanwhile writes no record either
    await purgeWalletCache(savedWalletRecord.wallet, () =>
      db.deleteWallet(name),
    );
  } finally {
    await db.close();
  }
}

export function getStorageProvider(
  dbName: string,
): StorageProvider | undefined {
  if (!BaseWallet.StorageProvider) {
    return undefined;
  }
  return new (BaseWallet.StorageProvider as any)(dbName);
}
