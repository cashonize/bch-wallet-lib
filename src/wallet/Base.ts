import { binToHex, CashAddressNetworkPrefix, sha256 } from "@bitauth/libauth";
import { purgeWalletCache, WalletCache } from "../cache/walletCache.js";
import { DUST_UTXO_THRESHOLD } from "../constant.js";
import StorageProvider from "../db/StorageProvider.js";
import { NetworkType, prefixFromNetworkMap } from "../enum.js";
import {
  DsproofData,
  HexHeaderI,
  NFTCapability,
  TxI,
  Utxo,
} from "../interface.js";
import { getNetworkProvider } from "../network/default.js";
import ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";
import { getRelayFeeCache } from "../network/getRelayFeeCache.js";
import { ElectrumRawTransaction } from "../network/interface.js";
import {
  amountNotMetError,
  buildEncodedTransaction,
  getFeeAmount,
  getFeeAmountSimple,
  getSuitableUtxos,
  getTokenChangeRequests,
  placeholderPrivateKeyBin,
  selectFungibleTokenUtxos,
} from "../transaction/Wif.js";
import type { TokenBurnAllowance } from "../transaction/tokenConservation.js";
import { asSendRequestObject } from "../util/asSendRequestObject.js";
import { checkUtxos } from "../util/checkUtxos.js";
import {
  getRuntimePlatform,
  sumTokenAmounts,
  sumUtxoValue,
  toTokenaddr,
} from "../util/index.js";
import { sumSendRequestAmounts } from "../util/sumSendRequestAmounts.js";
import { runCallback, waitOnWatch } from "../util/watch.js";
import { WalletTypeEnum } from "./enum.js";
import {
  InsufficientFundsError,
  InvalidRequestError,
  UtxoNotAvailableError,
} from "./errors.js";
import {
  CancelFn,
  SendRequestOptionsI,
  WaitForTransactionOptions,
  WaitForTransactionResponse,
  WatchOptions,
} from "./interface.js";
import {
  fromUtxoId,
  OpReturnData,
  SendRequest,
  SendRequestType,
  SendResponse,
  checkBurnRequest,
  checkGenesisRequest,
  checkMintRequest,
  TokenBurnRequest,
  TokenGenesisRequest,
  TokenMintRequest,
  TokenSendRequest,
  toUtxoId,
} from "./model.js";

export const placeholderCashAddr =
  "bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603";
export const placeholderTokenAddr =
  "bitcoincash:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqweyg7usz";

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

// The options a token operation passes on to its send
interface TokenOperationOptions extends SendRequestOptionsI {
  /** what the operation may burn; undefined when its caller turned the token check off */
  tokenBurns?: TokenBurnAllowance;
}

/**
 * A class to hold features used by all wallets
 * @class  BaseWallet
 */
export class BaseWallet {
  public static StorageProvider?: typeof StorageProvider;

  readonly walletCache: WalletCache;
  private _provider: ElectrumNetworkProvider;
  readonly network: NetworkType;
  readonly walletType: WalletTypeEnum;
  name: string = "";
  private subscriptions = new Set<WalletSubscription>();
  // Bumped by stop(), so that a subscription still being made when it ran is ended, not kept
  private stops = 0;
  private providerSwitch: Promise<void> = Promise.resolve();

  /** The electrum provider this wallet talks to; change it with setProvider() */
  public get provider(): ElectrumNetworkProvider {
    return this._provider;
  }

  public get networkPrefix(): CashAddressNetworkPrefix {
    return prefixFromNetworkMap[this.network];
  }

  //#region Accessors
  protected getNetworkProvider(
    network: NetworkType = NetworkType.Mainnet,
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
   * getTokenChangeAddress - get a cashtoken aware wallet change address
   *
   * @returns The cashtoken aware change address as a string
   */
  public getTokenChangeAddress(): string {
    throw Error("getTokenChangeAddress not implemented in BaseWallet");
  }

  /**
   * Token deposit addresses for `count` outputs that default to this wallet
   * in one transaction; an HD wallet gives each its own unused address.
   */
  protected getTokenDepositAddresses(count: number): string[] {
    return Array.from({ length: count }, () => this.getTokenDepositAddress());
  }

  // check if a given address belongs to this wallet
  public hasAddress(address: string): boolean {
    return (
      address === this.getDepositAddress() ||
      address === this.getChangeAddress()
    );
  }
  //#endregion Accessors

  //#region Constructors and Statics
  /**
   * constructor for a new wallet
   * @param network              network for wallet
   *
   * @throws {Error} if called on BaseWallet
   */
  constructor(network = NetworkType.Mainnet) {
    this.network = network;
    this.walletType = WalletTypeEnum.Watch;
    this._provider = this.getNetworkProvider(this.network);
    this.walletCache = new Map<string, { privateKey: Uint8Array }>();
  }
  //#endregion Constructors

  /**
   * named (internal) get a named wallet from the database or create a new one.
   * Note: this function should behave identically if
   *
   * @param {string} name              name of the wallet
   * @param {string} dbName            database name the wallet is stored in
   * @param {boolean} forceNew         attempt to overwrite an existing wallet
   *
   * @throws {Error} if forceNew is true and the wallet already exists
   * @returns a promise to a named wallet
   */
  protected async named(
    name: string,
    dbName?: string,
    forceNew: boolean = false,
  ): Promise<this> {
    if (!name?.length) {
      throw Error("Named wallets must have a non-empty name");
    }
    _checkContextSafety(this);
    this.name = name;
    dbName = dbName ? dbName : prefixFromNetworkMap[this.network];
    const db = getStorageProvider(dbName);

    // If there is a database, force saving or error
    if (db) {
      await db.init();
      const savedWalletRecord = await db.getWallet(name);
      if (savedWalletRecord) {
        await db.close();
        if (forceNew) {
          throw Error(
            `A wallet with the name ${name} already exists in ${dbName}`,
          );
        }
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
   * @param dbName name under which the wallet will be stored in the database
   *
   * @returns instantiated wallet
   */
  protected async replaceNamed(
    name: string,
    walletId: string,
    dbName?: string,
  ): Promise<this> {
    if (name.length === 0) {
      throw Error("Named wallets must have a non-empty name");
    }
    _checkContextSafety(this);
    this.name = name;
    dbName = dbName ? dbName : prefixFromNetworkMap[this.network];
    let db = getStorageProvider(dbName);

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
   * namedExists - check if a named wallet already exists
   *
   * @param name   user friendly wallet alias
   * @param dbName name under which the wallet will be stored in the database
   *
   * @returns boolean
   */
  protected async namedExists(name: string, dbName?: string): Promise<boolean> {
    if (name.length === 0) {
      throw Error("Named wallets must have a non-empty name");
    }
    _checkContextSafety(this);
    dbName = dbName ? dbName : prefixFromNetworkMap[this.network];
    let db = getStorageProvider(dbName);

    if (db) {
      await db.init();
      let savedWalletRecord = await db.getWallet(name);
      await db.close();
      return savedWalletRecord !== undefined;
    } else {
      throw Error(
        "No database was available or configured to store the named wallet.",
      );
    }
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
   * named - create a named wallet
   *
   * @param name   user friendly wallet alias
   * @param dbName name under which the wallet will be stored in the database
   * @param force  force recreate wallet in the database if a record already exist
   *
   * @returns instantiated wallet
   */
  public static async named<T extends typeof BaseWallet>(
    this: T,
    name: string,
    dbName?: string,
    force?: boolean,
  ): Promise<InstanceType<T>> {
    return new this().named(name, dbName, force) as InstanceType<T>;
  }

  /**
   * replaceNamed - replace (recover) named wallet with a new walletId
   *
   * If wallet with a provided name does not exist yet, it will be created with a `walletId` supplied
   * If wallet exists it will be overwritten without exception
   *
   * @param name   user friendly wallet alias
   * @param walletId walletId options to steer the creation process
   * @param dbName name under which the wallet will be stored in the database
   *
   * @returns instantiated wallet
   */
  public static async replaceNamed<T extends typeof BaseWallet>(
    this: T,
    name: string,
    walletId: string,
    dbName?: string,
  ): Promise<InstanceType<T>> {
    return new this().replaceNamed(name, walletId, dbName) as InstanceType<T>;
  }

  /**
   * namedExists - check if a named wallet already exists
   *
   * @param name   user friendly wallet alias
   * @param dbName name under which the wallet will be stored in the database
   *
   * @returns boolean
   */
  public static async namedExists(
    name: string,
    dbName?: string,
  ): Promise<boolean> {
    return new this().namedExists(name, dbName);
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
   * left connected, as other wallets may still use it. Each moved status watch fires again, so a
   * balance callback may get an unchanged value. If the new provider cannot connect or a
   * subscription cannot be made there, the wallet stays on the old provider and this rejects; if
   * the old provider fails as well while moving them back, some subscriptions stay on the new one
   * until setProvider is called again.
   */
  public async setProvider(provider: ElectrumNetworkProvider): Promise<void> {
    if ((provider.network as string) !== this.network) {
      throw new Error(
        `a ${provider.network} provider cannot serve a ${this.network} wallet`,
      );
    }
    const move = this.providerSwitch.then(() =>
      this.moveSubscriptions(provider),
    );
    this.providerSwitch = move.catch(() => {});
    await move;
  }

  private async moveSubscriptions(provider: ElectrumNetworkProvider) {
    // an unreachable server rejects here, before anything moved
    await provider.connect();
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
    const provider = this._provider;
    const stale = [...this.subscriptions].filter(
      (subscription) => subscription.provider !== provider,
    );
    const results = await Promise.allSettled(
      stale.map(async (subscription) => {
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
   * @param callback - Called when  the wallet has a status change; its errors go to `options.onError`
   * @returns Cancel function to stop watching
   */
  public async watchStatus(
    callback: (status: string | null, address: string) => unknown,
    options: WatchOptions = {},
  ): Promise<CancelFn> {
    return this.subscribe((provider) =>
      provider.watchAddressStatus(this.getDepositAddress(), (status) =>
        runCallback(
          () => callback(status, this.getDepositAddress()),
          options.onError,
        ),
      ),
    );
  }

  /**
   * No-op for single-address wallets. HDWallet overrides this to wait for
   * depositIndex/changeIndex advancement.
   */
  public async waitForUpdate(
    _options: {
      depositIndex?: number;
      changeIndex?: number;
      timeout?: number;
    } = {},
  ): Promise<void> {}

  // sets up a callback to be called upon wallet's balance change
  // can be cancelled by calling the function returned from this one
  // a failed balance read goes to options.onError, as the callback's own errors do
  public async watchBalance(
    callback: (balance: bigint) => unknown,
    options: WatchOptions = {},
  ): Promise<CancelFn> {
    return this.watchStatus(async () => {
      const balance = await this.getBalance();
      await callback(balance);
    }, options);
  }

  // waits for address balance to be greater than or equal to the target value
  // this call halts the execution; it rejects if the watch or a balance read fails
  public async waitForBalance(value: bigint): Promise<bigint> {
    // Check if condition is already met before watching
    const currentBalance = await this.getBalance();
    if (currentBalance >= value) {
      return currentBalance;
    }

    return waitOnWatch<bigint>((done, options) =>
      this.watchBalance((balance) => {
        if (balance >= value) done(balance);
      }, options),
    );
  }

  // sets up a callback to be called upon wallet's token balance change
  // can be cancelled by calling the function returned from this one
  // a failed balance read goes to options.onError, as the callback's own errors do
  public async watchTokenBalance(
    category: string,
    callback: (balance: bigint) => unknown,
    options: WatchOptions = {},
  ): Promise<CancelFn> {
    return await this.watchStatus(async () => {
      const balance = await this.getTokenBalance(category);
      await callback(balance);
    }, options);
  }

  // waits for address token balance to be greater than or equal to the target amount
  // this call halts the execution; it rejects if the watch or a balance read fails
  public async waitForTokenBalance(
    category: string,
    amount: bigint,
  ): Promise<bigint> {
    // Check if condition is already met before watching
    const currentBalance = await this.getTokenBalance(category);
    if (currentBalance >= amount) {
      return currentBalance;
    }

    return waitOnWatch<bigint>((done, options) =>
      this.watchTokenBalance(
        category,
        (balance) => {
          if (balance >= amount) done(balance);
        },
        options,
      ),
    );
  }

  /**
   * Watch wallet for new transactions. Transactions already in the history
   * when the watch starts are not reported; each new one is reported once.
   * @param callback - Called with new transaction hashes when they appear; its errors, and a
   * failed history read, go to `options.onError`
   * @returns Cancel function to stop watching
   */
  public async watchTransactionHashes(
    callback: (txHash: string) => unknown,
    options: WatchOptions = {},
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
        runCallback(() => callback(txHash), options.onError);
      }
    }, options);
  }

  /**
   * Watch wallet for new transactions
   * @param callback - Called with each new transaction; its errors, and a failed read of the
   * transaction or the history, go to `options.onError`
   * @returns Cancel function to stop watching
   */
  public async watchTransactions(
    callback: (transaction: ElectrumRawTransaction) => unknown,
    options: WatchOptions = {},
  ): Promise<CancelFn> {
    return this.watchTransactionHashes(async (txHash: string) => {
      const tx = await this.provider.getRawTransactionObject(txHash);
      await callback(tx);
    }, options);
  }

  public async watchTokenTransactions(
    callback: (tx: ElectrumRawTransaction) => unknown,
    options: WatchOptions = {},
  ): Promise<CancelFn> {
    return this.watchTransactions(
      async (transaction: ElectrumRawTransaction) => {
        if (transaction.vout.some((val) => val.tokenData)) {
          await callback(transaction);
        }
      },
      options,
    );
  }

  /**
   * Watch for double-spend proofs on incoming transactions.
   * For each new unconfirmed transaction, subscribes to its dsproof
   * for a short window. If a dsproof arrives, the callback is invoked.
   *
   * @param callback - Called with the dsproof data when a double-spend is detected; its errors,
   * and a failed dsproof subscription, go to `options.onError`
   * @param window - How long (ms) to watch each transaction for dsproofs (default 5000)
   * @returns Cancel function to stop watching
   */
  public async watchDoubleSpends(
    callback: (dsproof: DsproofData) => unknown,
    window: number = 5000,
    options: WatchOptions = {},
  ): Promise<CancelFn> {
    return this.watchTransactionHashes(async (txHash: string) => {
      const cancel = await this.subscribe((provider) =>
        provider.subscribeToDsproof(txHash, ([proofTxHash, dsproof]) => {
          if (txHash === proofTxHash && dsproof !== null) {
            runCallback(() => callback(dsproof), options.onError);
          }
        }),
      );

      setTimeout(() => runCallback(cancel, options.onError), window);
    }, options);
  }

  /**
   * The coins a spend may use: the wallet's current coins, narrowed to `utxoIds` when given (in
   * their order), minus `excludeUtxoIds`; and `ensureUtxos` resolved to coins of that pool.
   * Coins are compared by outpoint, so a caller's copy of a coin stands for the wallet's. The
   * token operations pick their inputs themselves and do not spend `ensureUtxos`, but a coin
   * named there outside the pool is refused for them too.
   */
  protected async getSpendPool(
    options?: SendRequestOptionsI,
  ): Promise<{ pool: Utxo[]; ensureUtxos: Utxo[] }> {
    // an id the wallet does not hold is a reservation that outlived its coin and is ignored, but
    // one that cannot be an outpoint is a mistake, and ignoring it would spend the coin it names
    const toExcludedOutpoint = (utxoId: Utxo | string) => {
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
          "An excludeUtxoIds entry is not a txid:vout outpoint",
          { field: "excludeUtxoIds", value: utxoId },
        );
      }
      return `${txid.toLowerCase()}:${vout}`;
    };
    const excluded = new Set(
      (options?.excludeUtxoIds ?? []).map(toExcludedOutpoint),
    );

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
      const utxoId = toUtxoId(utxo);
      if (excluded.has(utxoId) || seen.has(utxoId)) return false;
      seen.add(utxoId);
      return true;
    });

    const poolMap = new Map(pool.map((utxo) => [toUtxoId(utxo), utxo]));
    const walletIds = new Set(walletUtxos.map(toUtxoId));
    const ensureUtxos = (options?.ensureUtxos ?? []).map((utxo) => {
      const utxoId = toUtxoId(utxo);
      const inPool = poolMap.get(utxoId);
      if (inPool) return inPool;
      if (excluded.has(utxoId)) {
        throw new UtxoNotAvailableError(
          `Utxo ${utxoId} in ensureUtxos is excluded by excludeUtxoIds`,
          { utxoId, reason: "excluded" },
        );
      }
      if (!walletIds.has(utxoId)) {
        throw new UtxoNotAvailableError(
          `Utxo ${utxoId} in ensureUtxos not found in wallet`,
          { utxoId, reason: "not-found" },
        );
      }
      throw new UtxoNotAvailableError(
        `Utxo ${utxoId} in ensureUtxos is not among utxoIds`,
        { utxoId, reason: "not-in-utxoIds" },
      );
    });

    return { pool, ensureUtxos };
  }

  protected async _getMaxAmountToSend(
    options?: SendRequestOptionsI,
  ): Promise<{ value: bigint; utxos: Utxo[]; ensureUtxos: Utxo[] }> {
    // get inputs
    const { pool, ensureUtxos } = await this.getSpendPool(options);
    // a BCH sweep has no token change to price, so a token coin's satoshis would go to the miners
    const tokenCoin = ensureUtxos.find((utxo) => utxo.token);
    if (tokenCoin) {
      throw new InvalidRequestError(
        `Utxo ${toUtxoId(tokenCoin)} in ensureUtxos holds tokens, which a max send does not send`,
        { field: "ensureUtxos", value: toUtxoId(tokenCoin) },
      );
    }
    let utxos = pool;
    if (!options?.utxoIds) {
      utxos = pool.filter((utxo) => !utxo.token);
    }

    // the one output of a sendMax, sized as a P2PKH output
    const sendRequests = [
      new SendRequest({ cashaddr: placeholderCashAddr, value: 100n }),
    ];

    const fundingUtxos = await getSuitableUtxos(utxos, undefined, sendRequests);
    const relayFeePerByteInSatoshi = await getRelayFeeCache(this.provider);
    const fee = await getFeeAmountSimple({
      utxos: fundingUtxos,
      sendRequests: sendRequests,
      sourceAddress: placeholderCashAddr,
      relayFeePerByteInSatoshi: relayFeePerByteInSatoshi,
    });
    const spendableAmount = sumUtxoValue(fundingUtxos);

    let result = spendableAmount - fee;
    if (result < 0n) {
      result = 0n;
    }

    return { value: result, utxos: fundingUtxos, ensureUtxos };
  }

  /**
   * The amount a `sendMax` with these options sends: the BCH coins of the pool minus the fee of
   * spending them all to one output.
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
   * sendMax Send all available funds to a destination cash address
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
    const {
      value: maxSpendableAmount,
      utxos,
      ensureUtxos,
    } = await this._getMaxAmountToSend(options);

    // pinned as well: the selection would stop at the coins that cover the amount, leaving the
    // ones worth less than their own input fee unspent and their share of the fee to the miners.
    // The caller's ensureUtxos, all BCH coins of the pool and so among them, go first as in send.
    const ensureIds = new Set(ensureUtxos.map(toUtxoId));
    const inputs = [
      ...ensureUtxos,
      ...utxos.filter((utxo) => !ensureIds.has(toUtxoId(utxo))),
    ];
    options = { ...options, utxoIds: inputs, ensureUtxos: inputs };

    const sendRequest = new SendRequest({
      cashaddr: cashaddr,
      value: maxSpendableAmount,
    });

    const { encodedTransaction, categories } = await this.encodeTransaction(
      [sendRequest],
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

    // the wallet's own view of its coins includes the transaction when the send returns
    const [_, txId] = await Promise.all([
      this.waitForUpdate({ timeout: 2500 }),
      this.submitTransaction(encodedTransaction),
    ]);

    return { txId, transaction, categories };
  }

  // A token operation's send: the burns the operation allows reach the token conservation check
  protected async sendTokenOperation(
    requests: Array<SendRequest | TokenSendRequest | OpReturnData>,
    options: TokenOperationOptions,
  ): Promise<SendResponse> {
    const { encodedTransaction, categories } = await this.encodeTransaction(
      requests,
      undefined,
      options,
    );
    return this._send(encodedTransaction, categories, options);
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
    options?: TokenOperationOptions,
    privateKey?: Uint8Array,
  ) {
    let sendRequests = asSendRequestObject(requests);

    let checkTokenQuantities: boolean = true;
    if (options?.checkTokenQuantities === false) {
      checkTokenQuantities = false;
    }
    // A send burns no token; a token operation turns checkTokenQuantities off for its own coin
    // choice and says instead what it may burn, unless its caller turned the check off.
    let tokenBurns = options?.tokenBurns;
    if (!tokenBurns && checkTokenQuantities) {
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
      tokenChange = getTokenChangeRequests(
        tokenInputs,
        tokenRequests,
        toTokenaddr(this.getChangeAddress()),
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
    const estimateFee = (inputs: Utxo[]) =>
      getFeeAmountSimple({
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
      // The last round's estimate leaves out the fee of the coins the selection could not reach;
      // what is needed is told from the fee of spending every coin it could use.
      const pinnedIds = new Set(ensureUtxos.map(toUtxoId));
      const usable = [
        ...ensureUtxos,
        ...utxos.filter((val) => !val.token && !pinnedIds.has(toUtxoId(val))),
      ];
      const usableFee = await estimateFee(usable);
      let required = spendAmount + usableFee;
      if (shortfall.required > required) required = shortfall.required;
      throw amountNotMetError(required, shortfall.available);
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
      changeAddress: this.getChangeAddress(),
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
   * Broadcast a signed transaction and wait until the server reports it.
   * @throws {BroadcastRejectedError} If the server refused the transaction.
   * @returns The transaction id.
   */
  public async submitTransaction(transaction: Uint8Array): Promise<string> {
    if (!this.provider) {
      throw Error("Wallet network provider was not initialized");
    }
    const rawTransaction = binToHex(transaction);
    return await this.provider.sendRawTransaction(rawTransaction);
  }

  // gets transaction history of this wallet
  public async getRawHistory(_fromHeight: number = 0): Promise<TxI[]> {
    throw Error("getRawHistory not implemented in BaseWallet");
  }

  // gets last transaction of this wallet
  public async getLastTransaction(
    confirmedOnly: boolean = false,
  ): Promise<ElectrumRawTransaction | null> {
    let history: TxI[] = await this.getRawHistory();
    if (confirmedOnly) {
      history = history.filter((val) => val.height > 0);
    }

    if (!history.length) {
      return null;
    }

    const [lastTx] = history.slice(-1);
    return this.provider.getRawTransactionObject(lastTx.tx_hash);
  }

  // waits for next transaction, program execution is halted
  public async waitForTransaction(
    options: WaitForTransactionOptions = {
      getTransactionInfo: true,
      getBalance: false,
      txHash: undefined,
    },
  ): Promise<WaitForTransactionResponse> {
    if (options.getTransactionInfo === undefined) {
      options = { ...options, getTransactionInfo: true };
    }

    const makeResponse = async (txHash?: string) => {
      const response = <WaitForTransactionResponse>{};
      const promises: any[] = [undefined, undefined];

      if (options.getBalance === true) {
        promises[0] = this.getBalance();
      }

      if (options.getTransactionInfo === true) {
        if (!txHash) {
          promises[1] = this.getLastTransaction();
        } else {
          promises[1] = this.provider.getRawTransactionObject(txHash);
        }
      }

      const result = await Promise.all(promises);
      response.balance = result[0];
      response.transactionInfo = result[1];

      return response;
    };

    // waiting for a specific transaction to propagate
    const txHash = options.txHash;
    if (txHash) {
      await waitOnWatch<void>((done) =>
        this.subscribe((provider) =>
          provider.subscribeToTransaction(txHash, (data) => {
            if (data && data[0] === txHash && data[1] !== null) done();
          }),
        ),
      );
      return makeResponse(txHash);
    }

    // waiting for any address transaction; rejects if the watch fails
    await waitOnWatch<void>((done, watchOptions) =>
      this.watchStatus(() => done(), watchOptions),
    );
    return makeResponse();
  }

  /**
   * watchBlocks Watch network blocks
   *
   * @param callback callback with a block header object
   * @param skipCurrentHeight if set, the notification about current block will not arrive
   *
   * @returns a function which will cancel watching upon evaluation
   */
  public async watchBlocks(
    callback: (header: HexHeaderI) => unknown,
    skipCurrentHeight: boolean = true,
    options: WatchOptions = {},
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
        if (!seen) runCallback(() => callback(header), options.onError);
      }, false),
    );
  }

  /**
   * waitForBlock Wait for a network block
   *
   * @param height if specified waits for this exact blockchain height, otherwise resolves with the next block
   *
   */
  public async waitForBlock(height?: number): Promise<HexHeaderI> {
    return this.provider.waitForBlock(height);
  }

  //#endregion Funds

  //#region Cashtokens
  /**
   * Create one or more new cashtokens, fungible and/or non-fungible (NFT), in a single transaction.
   * Each genesis request consumes a distinct unspent output with vout=0; the spent prevout's txid
   * becomes the new token category.
   * Refer to spec https://github.com/cashtokens/cashtokens
   * @param  {TokenGenesisRequest | TokenGenesisRequest[]} genesisRequests one or more genesis requests.
   *   For each request:
   *   @param  {bigint?} amount amount of *fungible* tokens to create
   *   @param  {object?} nft NFT capability and commitment
   *   @param  {string?} cashaddr destination address; defaults to wallet's token deposit address
   *   @param  {bigint?} value satoshi value to send alongside tokens; defaults to 1000
   * @param  {SendRequestType | SendRequestType[]} sendRequests single or an array of extra send requests (OP_RETURN, value transfer, etc.) to include in genesis transaction
   * @param  {SendRequestOptionsI} options Options of the send requests
   */
  public async tokenGenesis(
    genesisRequests: TokenGenesisRequest | TokenGenesisRequest[],
    sendRequests: SendRequestType | SendRequestType[] = [],
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    if (!Array.isArray(genesisRequests)) {
      genesisRequests = [genesisRequests];
    }
    if (genesisRequests.length === 0) {
      throw new Error("tokenGenesis requires at least one request");
    }
    genesisRequests.forEach(checkGenesisRequest);
    if (!Array.isArray(sendRequests)) {
      sendRequests = [sendRequests];
    }

    const { pool: utxos } = await this.getSpendPool(options);

    const genesisInputs = utxos.filter((val) => val.vout === 0 && !val.token);
    if (genesisInputs.length < genesisRequests.length) {
      throw new InsufficientFundsError(
        `Not enough vout=0 inputs available for new token genesis: need ${genesisRequests.length}, have ${genesisInputs.length}`,
        { asset: "bch" },
      );
    }

    const pinnedInputs = genesisInputs.slice(0, genesisRequests.length);
    const depositAddresses = this.getTokenDepositAddresses(
      genesisRequests.filter((request) => !request.cashaddr).length,
    );
    const genesisSendRequests = genesisRequests.map(
      (request, i) =>
        new TokenSendRequest({
          cashaddr: request.cashaddr || depositAddresses.shift()!,
          amount: request.amount,
          value: request.value || 1000n,
          nft: request.nft,
          category: pinnedInputs[i].txid,
        }),
    );

    const extraRequests = sendRequests as Array<
      SendRequest | TokenSendRequest | OpReturnData
    >;
    return this.sendTokenOperation([...genesisSendRequests, ...extraRequests], {
      ...options,
      utxoIds: utxos,
      ensureUtxos: pinnedInputs,
      checkTokenQuantities: false,
      tokenOperation: "genesis",
      tokenBurns: options?.checkTokenQuantities === false ? undefined : {},
    });
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
    if (!Array.isArray(mintRequests)) {
      mintRequests = [mintRequests];
    }
    if (mintRequests.length === 0) {
      throw new Error("tokenMint requires at least one request");
    }

    const requestsByCategory = new Map<string, TokenMintRequest[]>();
    for (const request of mintRequests) {
      checkMintRequest(request);
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
          cashaddr: this.getTokenChangeAddress(),
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

    return this.sendTokenOperation(outputs, {
      ...options,
      ensureUtxos,
      checkTokenQuantities: false,
      tokenOperation: "mint",
      tokenBurns: options?.checkTokenQuantities === false ? undefined : {},
    });
  }

  /**
   * Perform an explicit token burning by spending one or more token utxos alongside an OP_RETURN.
   * Multiple burn requests across distinct categories can be bundled into a single transaction.
   *
   * Behaves differently for fungible and non-fungible tokens:
   *  * NFTs are always "destroyed"
   *  * FTs' amount is reduced by the amount specified; if 0 FT amount is left and no NFT present, the token is "destroyed"
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
    if (!Array.isArray(burnRequests)) {
      burnRequests = [burnRequests];
    }
    if (burnRequests.length === 0) {
      throw new Error("tokenBurn requires at least one request");
    }
    burnRequests.forEach(checkBurnRequest);

    const { pool: utxos } = await this.getSpendPool(options);
    const ensureUtxos: Utxo[] = [];
    const changeSendRequests: Array<SendRequest | TokenSendRequest> = [];
    const tokenBurns: Required<TokenBurnAllowance> = { fungible: {}, nfts: [] };

    for (const burnRequest of burnRequests) {
      const tokenUtxos = utxos.filter(
        (val) =>
          val.token?.category === burnRequest.category &&
          val.token?.nft?.capability === burnRequest.nft?.capability &&
          val.token?.nft?.commitment === burnRequest.nft?.commitment,
      );

      if (!tokenUtxos.length) {
        throw new InsufficientFundsError(
          `You do not have suitable token UTXOs to perform burn for category ${burnRequest.category}`,
          { asset: "token", category: burnRequest.category },
        );
      }

      const totalFungibleAmount = tokenUtxos.reduce(
        (prev, cur) => prev + (cur.token?.amount || 0n),
        0n,
      );
      let fungibleBurnAmount =
        burnRequest.amount && burnRequest.amount > 0 ? burnRequest.amount! : 0n;
      fungibleBurnAmount = BigInt(fungibleBurnAmount);
      const hasNFT = burnRequest.nft !== undefined;
      tokenBurns.fungible[burnRequest.category] =
        (tokenBurns.fungible[burnRequest.category] ?? 0n) + fungibleBurnAmount;
      if (hasNFT) {
        tokenBurns.nfts.push({
          category: burnRequest.category,
          ...burnRequest.nft!,
        });
      }

      if (hasNFT) {
        if (totalFungibleAmount === 0n) {
          ensureUtxos.push(tokenUtxos[0]);
        } else {
          let available = 0n;
          for (const token of tokenUtxos.filter((val) => val.token?.amount)) {
            ensureUtxos.push(token);
            available += token.token!.amount;
            if (available >= fungibleBurnAmount) {
              break;
            }
          }

          const newAmount = totalFungibleAmount - fungibleBurnAmount;
          const safeNewAmount = newAmount < 0n ? 0n : newAmount;
          changeSendRequests.push(
            new TokenSendRequest({
              cashaddr: toTokenaddr(this.getChangeAddress()),
              category: burnRequest.category,
              nft: burnRequest.nft,
              amount: safeNewAmount,
              value: tokenUtxos[0].satoshis,
            }),
          );
        }
      } else {
        if (totalFungibleAmount === fungibleBurnAmount) {
          ensureUtxos.push(...tokenUtxos);
        } else {
          let available = 0n;
          for (const token of tokenUtxos.filter((val) => val.token?.amount)) {
            ensureUtxos.push(token);
            available += token.token!.amount;
            if (available >= fungibleBurnAmount) {
              break;
            }
          }

          const newAmount = available - fungibleBurnAmount;
          const cashaddr = toTokenaddr(this.getChangeAddress());
          const value = tokenUtxos.reduce((a, c) => a + c.satoshis, 0n);
          if (newAmount > 0n) {
            changeSendRequests.push(
              new TokenSendRequest({
                cashaddr,
                category: burnRequest.category,
                amount: newAmount,
                value,
              }),
            );
          } else {
            // nothing left of the category: the plain output libauth built when it dropped the
            // empty token prefix of a zero-amount change
            changeSendRequests.push(new SendRequest({ cashaddr, value }));
          }
        }
      }
    }

    const opReturn = OpReturnData.fromString(message || "");
    return this.sendTokenOperation([opReturn, ...changeSendRequests], {
      ...options,
      checkTokenQuantities: false,
      ensureUtxos: ensureUtxos.length > 0 ? ensureUtxos : undefined,
      tokenOperation: "burn",
      tokenBurns:
        options?.checkTokenQuantities === false ? undefined : tokenBurns,
    });
  }

  /**
   * getTokenUtxos Get unspent token outputs for the wallet
   * will return utxos only for the specified token if `category` provided
   * @param  {string?} category category to filter utxos by, if not set will return utxos from all tokens
   * @returns  {Utxo[]} token utxos
   */
  public async getTokenUtxos(category?: string): Promise<Utxo[]> {
    const utxos = await this.getUtxos();
    return utxos.filter((val) =>
      category ? val.token?.category === category : val.token,
    );
  }

  /**
   * getTokenBalance Gets fungible token balance
   * for NFT token balance see @ref getNftTokenBalance
   * @param  {string} category category to get balance for
   * @returns  {bigint} fungible token balance
   */
  public async getTokenBalance(category: string): Promise<bigint> {
    const utxos = (await this.getTokenUtxos(category)).filter(
      (val) => val.token?.amount && val.token?.category === category,
    );
    return sumTokenAmounts(utxos, category);
  }

  /**
   * getNftTokenBalance Gets non-fungible token (NFT) balance for a particular category
   * disregards fungible token balances
   * for fungible token balance see @ref getTokenBalance
   * @param  {string} category category to get balance for
   * @returns  {number} non-fungible token balance
   */
  public async getNftTokenBalance(category: string): Promise<number> {
    const utxos = (await this.getTokenUtxos(category)).filter(
      (val) => val.token?.nft?.commitment !== undefined,
    );
    return utxos.length;
  }

  /**
   * getAllTokenBalances Gets all fungible token balances in this wallet
   * @returns  {Object} a map [category => balance] for all tokens in this wallet
   */
  public async getAllTokenBalances(): Promise<{ [category: string]: bigint }> {
    const result = {};
    const utxos = (await this.getTokenUtxos()).filter(
      (val) => val.token?.amount,
    );
    for (const utxo of utxos) {
      if (!result[utxo.token!.category]) {
        result[utxo.token!.category] = 0n;
      }
      result[utxo.token!.category] += utxo.token!.amount;
    }
    return result;
  }

  /**
   * getAllNftTokenBalances Gets all non-fungible token (NFT) balances in this wallet
   * @returns  {Object} a map [category => balance] for all NFTs in this wallet
   */
  public async getAllNftTokenBalances(): Promise<{
    [category: string]: number;
  }> {
    const result = {};
    const utxos = (await this.getTokenUtxos()).filter(
      (val) => val.token?.nft?.commitment !== undefined,
    );
    for (const utxo of utxos) {
      if (!result[utxo.token!.category]) {
        result[utxo.token!.category] = 0;
      }
      result[utxo.token!.category] += 1;
    }
    return result;
  }
  //#endregion Cashtokens
}

/**
 * _checkContextSafety (internal) if running in nodejs, will disable saving
 * mainnet wallets on public servers if ALLOW_MAINNET_USER_WALLETS is set to false
 * @param {BaseWallet} wallet        a wallet
 */
export const _checkContextSafety = function (wallet: BaseWallet) {
  if (getRuntimePlatform() === "node") {
    if (process.env.ALLOW_MAINNET_USER_WALLETS === `false`) {
      if (wallet.network === NetworkType.Mainnet) {
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
 * @returns the stored wallet id, or undefined if there is no wallet of that name
 */
export async function getNamedWalletId(
  name: string,
  dbName?: string,
): Promise<string | undefined> {
  if (name.length === 0) {
    throw Error("Named wallets must have a non-empty name");
  }

  dbName = dbName ? dbName : prefixFromNetworkMap[NetworkType.Mainnet];
  let db = getStorageProvider(dbName);

  if (db) {
    await db.init();
    let savedWalletRecord = await db.getWallet(name);
    await db.close();
    return savedWalletRecord?.wallet;
  } else {
    throw Error(
      "No database was available or configured to store the named wallet.",
    );
  }
}

/**
 * deleteNamedWallet - delete a named wallet from the database, and its cache record with it
 *
 * `StorageProvider.deleteWallet` removes only the row; the wallet's cache record (its derived
 * private keys and history, see {@link purgeWalletCache}) is removed here too, before the row,
 * and a loaded wallet of that id no longer writes it. No-op for a missing name.
 *
 * @param name   user friendly wallet alias
 * @param dbName database the wallet is stored in, the mainnet one ("bitcoincash") by default
 *
 * @throws {Error} if no StorageProvider is configured, if the row's wallet id cannot be read, or
 * if the cache record could not be removed; the row is kept in each case
 */
export async function deleteNamedWallet(
  name: string,
  dbName?: string,
): Promise<void> {
  if (name.length === 0) {
    throw Error("Named wallets must have a non-empty name");
  }

  dbName = dbName ? dbName : prefixFromNetworkMap[NetworkType.Mainnet];
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
    // the cache record first: if it cannot be removed, the row that leads to it stays
    await purgeWalletCache(savedWalletRecord.wallet);
    await db.deleteWallet(name);
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
