import { binToBase64, utf8ToBin } from "@bitauth/libauth";
import { IndexedDbCache } from "../cache/IndexedDbCache.js";
import { CacheProvider } from "../cache/interface.js";
import { Config } from "../config.js";
import { HeaderI, HexHeaderI, Network, TxI, Utxo } from "../interface.js";
import { decodeHeader } from "../util/header.js";
import {
  DEFAULT_CONCURRENCY,
  Limiter,
  mapConcurrent,
} from "../util/mapConcurrent.js";
import { toError } from "../util/toError.js";
import { getTransactionHash } from "../util/transaction.js";
import { runCallback, waitOnWatch } from "../util/watch.js";
import { CancelFn } from "../wallet/interface.js";
import {
  ElectrumRawTransaction,
  ElectrumRawTransactionVinWithValues,
  ElectrumRawTransactionWithInputValues,
  ElectrumUtxo,
} from "./interface.js";
import {
  BroadcastRejectedError,
  BroadcastTimeoutError,
  parseRejection,
  serverErrorCode,
} from "./errors.js";
import type { Transport } from "./Transport.js";

/** Options of the provider calls that fan out over a list. */
export interface ConcurrencyOptions {
  /** Requests in flight at most for this call, a positive integer or `Infinity` (no limit). Default 10. */
  concurrency?: number;
  /** @internal A bound shared with other fan-outs, instead of `concurrency` */
  limiter?: Limiter;
}

// Fulcrum reports a transaction it accepted within a second or two
const BROADCAST_STATUS_TIMEOUT = 30_000;

/** Internal type for cached verbose transactions. fetchHeight is stripped before returning. */
type CachedRawTransaction = ElectrumRawTransaction & { fetchHeight: number };

/** The connection to one Electrum server (Fulcrum) that wallets read the chain from and broadcast to. */
export default class ElectrumNetworkProvider {
  private readonly transport: Transport;
  private subscriptionCount: number = 0;
  private currentHeight: number = 0;
  private headerCancelFn?: CancelFn;

  private _cache: CacheProvider | undefined;

  private get cache(): CacheProvider | undefined {
    if (!Config.UseIndexedDBCache) {
      this._cache = undefined;
    } else if (!this._cache) {
      this._cache = new IndexedDbCache();
    }
    return this._cache;
  }

  // The cache, opened before it is read: a provider's first call can be a read, before any request
  // has opened it
  private async openedCache(): Promise<CacheProvider | undefined> {
    const cache = this.cache;
    await cache?.init();
    return cache;
  }

  /** @internal The subscriptions open on this provider, for the tests that check none leak. */
  get subscriptions(): number {
    return this.subscriptionCount;
  }

  constructor(
    transport: Transport,
    public network: Network = Network.MAINNET,
  ) {
    if (transport) {
      this.transport = transport;
    } else {
      throw new Error(`A transport is required.`);
    }
  }

  /**
   * All UTXOs (confirmed and unconfirmed) of an address, token coins included.
   * @param cashaddr The CashAddress whose UTXOs to retrieve.
   */
  async getUtxos(cashaddr: string): Promise<Utxo[]> {
    const result = await this.performRequest<ElectrumUtxo[]>(
      "blockchain.address.listunspent",
      [cashaddr, "include_tokens"],
    );
    return result.map((utxo) => ({
      address: cashaddr,
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      satoshis: BigInt(utxo.value),
      height: utxo.height,
      token: utxo.token_data
        ? {
            ...utxo.token_data,
            amount: BigInt(utxo.token_data.amount),
          }
        : undefined,
    }));
  }

  /**
   * Batch retrieve raw transactions by their hashes.
   * @param hashes Array of transaction hashes.
   * @param options.concurrency Requests in flight at most for the cache misses. Default 10.
   * @returns Map from hash to hex transaction string.
   */
  async getRawTransactions(
    hashes: string[],
    options: ConcurrencyOptions = {},
  ): Promise<Map<string, string>> {
    if (hashes.length === 0) return new Map();

    const results = new Map<string, string>();
    const keys = hashes.map((hash) => `txraw-${this.network}-${hash}`);

    // batch cache read
    const cache = await this.openedCache();
    let cached: Map<string, string | null> | undefined;
    if (cache) {
      cached = await cache.getItems(keys);
    }

    const misses: string[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const val = cached?.get(keys[i]);
      if (val) {
        results.set(hashes[i], val);
      } else {
        misses.push(hashes[i]);
      }
    }

    if (misses.length > 0) {
      const fetched = await mapConcurrent(
        misses,
        options.limiter ?? options.concurrency ?? DEFAULT_CONCURRENCY,
        async (hash) => {
          const tx = await this.performRequest<string>(
            "blockchain.transaction.get",
            [hash, false],
          );
          await checkTransactionHash(hash, tx);
          return [hash, tx] as [string, string];
        },
      );

      // batch cache write
      if (cache) {
        const entries: [string, string][] = fetched.map(([hash, tx]) => [
          `txraw-${this.network}-${hash}`,
          tx,
        ]);
        await cache.setItems(entries);
      }

      for (const [hash, tx] of fetched) {
        results.set(hash, tx);
      }
    }

    return results;
  }

  /**
   * Batch retrieve block headers by their heights.
   * @param heights Array of block heights.
   * @param options.concurrency Requests in flight at most for the cache misses. Default 10.
   * @returns Map from height to decoded header.
   */
  async getHeaders(
    heights: number[],
    options: ConcurrencyOptions = {},
  ): Promise<Map<number, HeaderI>> {
    if (heights.length === 0) return new Map();

    const results = new Map<number, HeaderI>();
    const keys = heights.map(
      (height) => `header-${this.network}-${height}-true`,
    );

    // batch cache read
    const cache = await this.openedCache();
    let cached: Map<string, string | null> | undefined;
    if (cache) {
      cached = await cache.getItems(keys);
    }

    const misses: number[] = [];
    for (let i = 0; i < heights.length; i++) {
      const val = cached?.get(keys[i]);
      if (val) {
        results.set(heights[i], decodeHeader(JSON.parse(val)));
      } else {
        misses.push(heights[i]);
      }
    }

    if (misses.length > 0) {
      const fetched = await mapConcurrent(
        misses,
        options.limiter ?? options.concurrency ?? DEFAULT_CONCURRENCY,
        async (height) => {
          const result = await this.performRequest<HexHeaderI>(
            "blockchain.header.get",
            [height],
          );
          return [height, result] as [number, HexHeaderI];
        },
      );

      // batch cache write
      if (cache) {
        const entries: [string, string][] = fetched.map(([height, result]) => [
          `header-${this.network}-${height}-true`,
          JSON.stringify(result),
        ]);
        await cache.setItems(entries);
      }

      for (const [height, result] of fetched) {
        results.set(height, decodeHeader(result));
      }
    }

    return results;
  }

  /** The current block height, kept up to date by a header subscription opened on the first call. */
  async getBlockHeight(): Promise<number> {
    if (!this.headerCancelFn) {
      this.headerCancelFn = await this.subscribeToHeaders(
        (header: HexHeaderI) => {
          if (header.height > this.currentHeight) {
            this.currentHeight = header.height;
          }
        },
      );
    }

    if (!this.currentHeight) {
      throw new Error(
        "Check failed for eventual inconsistency in subscription implementations.",
      );
    }
    return this.currentHeight;
  }

  /**
   * The raw transaction hex of a transaction ID.
   * @throws {Error} If the transaction does not exist
   */
  async getRawTransaction(txHash: string): Promise<string> {
    const key = `txraw-${this.network}-${txHash}`;
    const cache = await this.openedCache();
    if (cache) {
      const cached = await cache.getItem(key);
      if (cached) return cached;
    }

    const hex = await this.fetchTransaction<string>(txHash, false);
    if (cache) {
      await cache.setItem(key, hex);
    }
    return hex;
  }

  private async fetchTransaction<T extends string | { hex: string }>(
    txHash: string,
    verbose: boolean,
  ): Promise<T> {
    let transaction: T;
    try {
      transaction = await this.performRequest<T>("blockchain.transaction.get", [
        txHash,
        verbose,
      ]);
    } catch (error: any) {
      if (
        (error.message as string).indexOf(
          "No such mempool or blockchain transaction",
        ) > -1
      )
        throw Error(
          `Could not decode transaction ${txHash}. It might not exist on the current blockchain (${this.network}).`,
        );
      else throw error;
    }
    let hex: string;
    if (typeof transaction === "string") hex = transaction;
    else hex = transaction.hex;
    await checkTransactionHash(txHash, hex);
    return transaction;
  }

  private async enrichWithInputValues(
    transaction: ElectrumRawTransaction,
  ): Promise<ElectrumRawTransactionWithInputValues> {
    const hashes = [...new Set(transaction.vin.map((val) => val.txid))];
    const transactions = await mapConcurrent(
      hashes,
      DEFAULT_CONCURRENCY,
      (hash) => this.getRawTransactionObject(hash, false),
    );
    const transactionMap = new Map<string, ElectrumRawTransaction>();
    transactions.forEach((val) => transactionMap.set(val.hash, val));

    const enrichedVin: ElectrumRawTransactionVinWithValues[] =
      transaction.vin.map((input) => {
        const output = transactionMap
          .get(input.txid)!
          .vout.find((val) => val.n === input.vout)!;
        return { ...input, ...output };
      });

    return { ...transaction, vin: enrichedVin };
  }

  /**
   * The decoded transaction of a transaction ID.
   * @param loadInputValues When true, each vin is enriched with value, address and tokenData from the parent output.
   * @throws {Error} If the transaction does not exist
   */
  async getRawTransactionObject(
    txHash: string,
    loadInputValues: true,
  ): Promise<ElectrumRawTransactionWithInputValues>;
  async getRawTransactionObject(
    txHash: string,
    loadInputValues?: false,
  ): Promise<ElectrumRawTransaction>;
  async getRawTransactionObject(
    txHash: string,
    loadInputValues: boolean = false,
  ): Promise<ElectrumRawTransaction | ElectrumRawTransactionWithInputValues> {
    const key = `tx-${this.network}-${txHash}`;
    let cachedTx: CachedRawTransaction | undefined;
    const cache = await this.openedCache();
    if (cache) {
      const cached = await cache.getItem(key);
      if (cached) {
        cachedTx = JSON.parse(cached) as CachedRawTransaction;
        if (cachedTx.confirmations > 0) {
          const currentHeight = await this.getBlockHeight();
          cachedTx.confirmations += currentHeight - cachedTx.fetchHeight;
        } else {
          // an unconfirmed entry cannot tell whether it has confirmed since, so it is fetched again
          cachedTx = undefined;
        }
      }
    }

    if (!cachedTx) {
      cachedTx = await this.fetchTransaction<CachedRawTransaction>(
        txHash,
        true,
      );
      cachedTx.confirmations ??= 0;
      cachedTx.fetchHeight = await this.getBlockHeight();
      if (cache) {
        await cache.setItem(key, JSON.stringify(cachedTx));
      }
    }

    const { fetchHeight: _, ...transaction } = cachedTx;
    if (loadInputValues) {
      return this.enrichWithInputValues(transaction);
    }
    return transaction;
  }

  /**
   * Broadcast a raw hex transaction and wait until the server reports it. A node that answers it
   * already holds the transaction (BroadcastRejectedError's `alreadyKnown`) has it from an earlier
   * broadcast, so that answer returns the txid too. A server that accepts the broadcast but does
   * not report the transaction within 30 seconds is asked for it once: the txid when it has it,
   * a BroadcastTimeoutError when not. A broadcast that times out or loses its connection may have
   * reached the node all the same, so the server is asked for the transaction in that case too.
   * @param txHex The raw transaction hex to be broadcast.
   * @param options.statusTimeout @internal Milliseconds to wait for the report, for the tests.
   * @throws {BroadcastRejectedError} If the server refused the transaction, with the node's reject reason.
   * @throws {BroadcastTimeoutError} If the broadcast's outcome is unknown and the server does not hold the transaction.
   * @returns The transaction ID (hash) corresponding to the broadcast transaction.
   */
  async sendRawTransaction(
    txHex: string,
    options: { statusTimeout?: number } = {},
  ): Promise<string> {
    const txHash = await getTransactionHash(txHex);
    const statusTimeout = options.statusTimeout ?? BROADCAST_STATUS_TIMEOUT;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // set once the wait has its outcome, so that a broadcast answered after it starts no timer
    let settled = false;
    await waitOnWatch<void>(async (done, { onError }) => {
      const finish = (error?: unknown) => {
        settled = true;
        clearTimeout(timer);
        if (error === undefined) done();
        else onError(error);
      };
      const cancel = await this.subscribeToTransaction(txHash, (data) => {
        if (data && data[0] === txHash && data[1] !== null) finish();
      });
      // broadcast once subscribed, so that the transaction's first status is not missed
      this.performRequest("blockchain.transaction.broadcast", [txHex]).then(
        () => {
          if (settled) return;
          // the request timeout bounds the broadcast itself, this the report that follows it
          timer = setTimeout(() => {
            this.holdsTransaction(
              txHash,
              txHex,
              `The server accepted transaction ${txHash} but did not report it within ${statusTimeout} ms`,
            ).then(() => finish(), finish);
          }, statusTimeout);
        },
        (error) => {
          const rejection = broadcastError(error, txHash);
          if (!(rejection instanceof BroadcastRejectedError)) {
            // not the server's answer: the transaction may have reached the node before the failure
            this.holdsTransaction(
              txHash,
              txHex,
              `The broadcast of transaction ${txHash} failed (${rejection.message})`,
              rejection,
            ).then(() => finish(), finish);
          } else if (rejection.alreadyKnown) {
            // the node holds a transaction of this txid, the hash of these very bytes
            finish();
          } else {
            finish(rejection);
          }
        },
      );
      return cancel;
    });
    return txHash;
  }

  // The one check after a broadcast whose outcome is unknown: whether the server holds the transaction
  private async holdsTransaction(
    txHash: string,
    txHex: string,
    outcome: string,
    cause?: unknown,
  ): Promise<void> {
    try {
      await this.performRequest("blockchain.transaction.get", [txHash, false]);
    } catch (error) {
      throw new BroadcastTimeoutError(
        `${outcome}, and the server does not hold it.`,
        { txid: txHash, transaction: txHex, cause: cause ?? error },
      );
    }
  }

  /**
   * The confirmed and unconfirmed history of an address, in the server's order.
   * @param fromHeight @internal Only the transactions from this height on, and the unconfirmed ones; the wallets' incremental refresh.
   */
  async getHistory(cashaddr: string, fromHeight: number = 0): Promise<TxI[]> {
    return this.performRequest<TxI[]>("blockchain.address.get_history", [
      cashaddr,
      fromHeight,
      -1,
    ]);
  }

  /** The server's minimum relay fee, in BCH per kB. */
  async getRelayFee(): Promise<number> {
    return this.performRequest<number>("blockchain.relayfee");
  }

  public async watchAddressStatus(
    cashaddr: string,
    callback: (status: string | null) => unknown,
  ): Promise<CancelFn> {
    const watchAddressStatusCallback = (
      data: [address: string, status: string | null],
    ) => {
      // subscription acknowledgement is the latest known status or null if no status is known
      // status is an array: [ cashaddr, statusHash ]
      if (data instanceof Array && data[0] === cashaddr) {
        return callback(data[1]);
      }
      return undefined;
    };

    return this.subscribeToAddress(cashaddr, watchAddressStatusCallback);
  }

  // watch for block headers and block height, if `skipCurrentHeight` is set, the notification about current block will not arrive
  public async watchBlocks(
    callback: (header: HexHeaderI) => unknown,
    skipCurrentHeight: boolean = true,
  ): Promise<CancelFn> {
    let acknowledged = !skipCurrentHeight;
    const waitForBlockCallback = (_header: HexHeaderI | HexHeaderI[]) => {
      if (!acknowledged) {
        acknowledged = true;
        return;
      }

      _header = _header instanceof Array ? _header[0] : _header;
      return callback(_header);
    };
    return this.subscribeToHeaders(waitForBlockCallback);
  }

  // subscribe to notifications sent when new block is found, the block header is sent to callback
  private async subscribeToHeaders(
    callback: (header: HexHeaderI) => unknown,
  ): Promise<CancelFn> {
    return this.subscribeRequest("blockchain.headers.subscribe", [], (data) =>
      callback(data[0]),
    );
  }

  /**
   * Subscribe to an address's status: the callback gets `[cashaddr, status]`, first for the current
   * status and then for every change.
   */
  async subscribeToAddress(
    cashaddr: string,
    callback: (data: [address: string, status: string | null]) => unknown,
  ): Promise<CancelFn> {
    return this.subscribeRequest(
      "blockchain.address.subscribe",
      [cashaddr],
      callback,
    );
  }

  /**
   * Subscribe to a transaction's confirmation status: the callback gets `[txHash, confirmations]`,
   * with null confirmations while the server does not know the transaction.
   */
  async subscribeToTransaction(
    txHash: string,
    callback: (data: [txHash: string, confirmations: number | null]) => unknown,
  ): Promise<CancelFn> {
    return this.subscribeRequest(
      "blockchain.transaction.subscribe",
      [txHash],
      callback,
    );
  }

  /**
   * @internal Regtest only. Fulcrum's daemon.passthrough takes named params, which electrum-cash
   * cannot send, so this calls generatetoaddress on the node's own RPC, with the RPC_* settings of
   * the regtest.
   */
  async mine(cashaddr: string, blocks: number): Promise<string[]> {
    const env = typeof process === "undefined" ? {} : process.env;
    const credentials = utf8ToBin(`${env.RPC_USER}:${env.RPC_PASS}`);
    const init = {
      method: "POST",
      headers: {
        Authorization: `Basic ${binToBase64(credentials)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: "mine",
        method: "generatetoaddress",
        params: [blocks, cashaddr],
      }),
    };

    let unreachable: unknown;
    for (const host of ["127.0.0.1", "host.docker.internal"]) {
      let response: Response;
      try {
        response = await fetch(`http://${host}:${env.RPC_PORT}/`, init);
      } catch (error) {
        unreachable = error;
        continue;
      }
      const { result, error } = await response.json();
      if (error) throw new Error(`generatetoaddress failed: ${error.message}`);
      return result;
    }
    throw new Error("The regtest node's RPC is not reachable.", {
      cause: unreachable,
    });
  }

  protected async performRequest<T = unknown>(
    method: string,
    parameters: unknown[] = [],
  ): Promise<T> {
    await this.connect();
    return this.transport.request(method, parameters) as Promise<T>;
  }

  protected async subscribeRequest(
    method: string,
    parameters: unknown[],
    callback: (data: any) => unknown,
  ): Promise<CancelFn> {
    await this.connect();

    // a callback's throw or rejection is reported, and it stays subscribed
    const unsubscribe = await this.transport.subscribe(
      method,
      parameters,
      (data) => runCallback(() => callback(data)),
    );
    this.subscriptionCount++;

    return async () => {
      await unsubscribe();
      this.subscriptionCount--;
    };
  }

  /** Connect to the server; resolves when connected, rejects when no connection can be made. */
  async connect(): Promise<void> {
    await this.cache?.init();
    await this.transport.connect();
  }

  /**
   * Close the connection and the provider's own header subscription, for good: a request made on
   * the provider afterwards rejects rather than connecting again. A new provider connects anew.
   */
  async disconnect(): Promise<boolean> {
    await this.headerCancelFn?.();
    await this.transport.close();
    return true;
  }
}

// A server's error response to a broadcast is a refusal; a timeout or a lost connection is not, as
// the transaction may still have reached the node
// A server's transaction is cached by the txid it was asked for, where it would outlast a switch to
// another server, so it must be the transaction of that txid. The server's decoded fields of a
// verbose transaction are not checked against its hex.
async function checkTransactionHash(txHash: string, hex: string) {
  const hash = await getTransactionHash(hex);
  if (hash !== txHash.toLowerCase()) {
    throw new Error(
      `The server answered the request for transaction ${txHash} with transaction ${hash}.`,
    );
  }
}

function broadcastError(error: unknown, txid: string): Error {
  if (serverErrorCode(error) === undefined) return toError(error);
  const { message } = error as Error;
  const reason = parseRejection(message);
  return new BroadcastRejectedError(message, {
    reason,
    txid,
    cause: error,
  });
}
