import { binToBase64, utf8ToBin } from "@bitauth/libauth";
import { IndexedDbCache } from "../cache/IndexedDbCache.js";
import { CacheProvider } from "../cache/interface.js";
import { MemoryCache } from "../cache/MemoryCache.js";
import { Config } from "../config.js";
import {
  DsproofData,
  HeaderI,
  HexHeaderI,
  Network,
  TxI,
  Utxo,
} from "../interface.js";
import { decodeHeader } from "../util/header.js";
import { DEFAULT_CONCURRENCY, mapConcurrent } from "../util/mapConcurrent.js";
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
  parseRejection,
  serverErrorCode,
} from "./errors.js";
import {
  ConcurrencyOptions,
  default as NetworkProvider,
} from "./NetworkProvider.js";
import type { Transport } from "./Transport.js";

/** Internal type for cached verbose transactions. fetchHeight is stripped before returning. */
type CachedRawTransaction = ElectrumRawTransaction & { fetchHeight: number };

export default class ElectrumNetworkProvider implements NetworkProvider {
  public transport: Transport;
  public subscriptions: number = 0;
  private currentHeight: number = 0;
  private headerCancelFn?: CancelFn;

  private _cache: CacheProvider | undefined;

  get cache(): CacheProvider | undefined {
    if (!Config.UseMemoryCache && !Config.UseIndexedDBCache) {
      this._cache = undefined;
      return this._cache;
    }

    if (Config.UseMemoryCache && !(this._cache instanceof MemoryCache)) {
      this._cache = new MemoryCache();
      return this._cache;
    }

    if (Config.UseIndexedDBCache && !(this._cache instanceof IndexedDbCache)) {
      this._cache = new IndexedDbCache();
      return this._cache;
    }

    return this._cache;
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

  async getBalance(cashaddr: string): Promise<bigint> {
    const result = await this.performRequest<{
      confirmed: number;
      unconfirmed: number;
    }>("blockchain.address.get_balance", [cashaddr]);

    return BigInt(result.confirmed) + BigInt(result.unconfirmed);
  }

  async getHeader(
    height: number,
    verbose: boolean = false,
  ): Promise<HeaderI | HexHeaderI> {
    const key = `header-${this.network}-${height}-${verbose}`;

    if (this.cache) {
      const cached = await this.cache.getItem(key);
      if (cached) {
        return verbose ? decodeHeader(JSON.parse(cached)) : JSON.parse(cached);
      }
    }

    const result = await this.performRequest<HexHeaderI>(
      "blockchain.header.get",
      [height],
    );
    if (this.cache) {
      await this.cache.setItem(key, JSON.stringify(result));
    }

    return verbose ? decodeHeader(result) : result;
  }

  async getRawTransactions(
    hashes: string[],
    options: ConcurrencyOptions = {},
  ): Promise<Map<string, string>> {
    if (hashes.length === 0) return new Map();

    const results = new Map<string, string>();
    const keys = hashes.map((hash) => `txraw-${this.network}-${hash}`);

    // batch cache read
    let cached: Map<string, string | null> | undefined;
    if (this.cache) {
      cached = await this.cache.getItems(keys);
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
        options.concurrency ?? DEFAULT_CONCURRENCY,
        async (hash) => {
          const tx = await this.performRequest<string>(
            "blockchain.transaction.get",
            [hash, false],
          );
          return [hash, tx] as [string, string];
        },
      );

      // batch cache write
      if (this.cache) {
        const entries: [string, string][] = fetched.map(([hash, tx]) => [
          `txraw-${this.network}-${hash}`,
          tx,
        ]);
        await this.cache.setItems(entries);
      }

      for (const [hash, tx] of fetched) {
        results.set(hash, tx);
      }
    }

    return results;
  }

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
    let cached: Map<string, string | null> | undefined;
    if (this.cache) {
      cached = await this.cache.getItems(keys);
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
        options.concurrency ?? DEFAULT_CONCURRENCY,
        async (height) => {
          const result = await this.performRequest<HexHeaderI>(
            "blockchain.header.get",
            [height],
          );
          return [height, result] as [number, HexHeaderI];
        },
      );

      // batch cache write
      if (this.cache) {
        const entries: [string, string][] = fetched.map(([height, result]) => [
          `header-${this.network}-${height}-true`,
          JSON.stringify(result),
        ]);
        await this.cache.setItems(entries);
      }

      for (const [height, result] of fetched) {
        results.set(height, decodeHeader(result));
      }
    }

    return results;
  }

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

  async getRawTransaction(
    txHash: string,
    verbose: true,
    loadInputValues: true,
  ): Promise<ElectrumRawTransactionWithInputValues>;
  async getRawTransaction(
    txHash: string,
    verbose: true,
    loadInputValues?: false,
  ): Promise<ElectrumRawTransaction>;
  async getRawTransaction(
    txHash: string,
    verbose?: false,
    loadInputValues?: false,
  ): Promise<string>;
  async getRawTransaction(
    txHash: string,
    verbose: boolean = false,
    loadInputValues: boolean = false,
  ): Promise<
    string | ElectrumRawTransaction | ElectrumRawTransactionWithInputValues
  > {
    const nonVerboseKey = `txraw-${this.network}-${txHash}`;
    const verboseKey = `tx-${this.network}-${txHash}`;
    const key = verbose ? verboseKey : nonVerboseKey;

    if (this.cache) {
      const cached = await this.cache.getItem(key);
      if (cached) {
        if (!verbose) {
          return cached;
        }

        const cachedTx = JSON.parse(cached) as CachedRawTransaction;
        if (cachedTx.confirmations > 0) {
          const currentHeight = await this.getBlockHeight();
          cachedTx.confirmations += currentHeight - cachedTx.fetchHeight;
        }
        const { fetchHeight: _, ...transaction } = cachedTx;

        if (loadInputValues) {
          return this.enrichWithInputValues(transaction);
        }

        return transaction;
      }
    }

    try {
      const result = await this.performRequest<string | ElectrumRawTransaction>(
        "blockchain.transaction.get",
        [txHash, verbose],
      );

      if (!verbose) {
        const hex = result as string;
        if (this.cache) {
          await this.cache.setItem(key, hex);
        }
        return hex;
      }

      const cachedTx = result as CachedRawTransaction;
      cachedTx.confirmations ??= 0;
      cachedTx.fetchHeight = await this.getBlockHeight();

      if (this.cache) {
        await this.cache.setItem(key, JSON.stringify(cachedTx));
      }

      const { fetchHeight: _, ...transaction } = cachedTx;

      if (loadInputValues) {
        return this.enrichWithInputValues(transaction);
      }

      return transaction;
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

  // gets the decoded transaction in human readable form
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
    if (loadInputValues) {
      return this.getRawTransaction(txHash, true, true);
    }
    return this.getRawTransaction(txHash, true);
  }

  async sendRawTransaction(
    txHex: string,
    awaitPropagation: boolean = true,
  ): Promise<string> {
    const txHash = await getTransactionHash(txHex);
    if (!awaitPropagation) {
      this.performRequest("blockchain.transaction.broadcast", [txHex]).catch(
        () => {},
      );
      return txHash;
    }
    await waitOnWatch<void>(async (done, { onError }) => {
      const cancel = await this.subscribeToTransaction(txHash, (data) => {
        if (data && data[0] === txHash && data[1] !== null) done();
      });
      // broadcast once subscribed, so that the transaction's first status is not missed
      this.performRequest("blockchain.transaction.broadcast", [txHex]).catch(
        (error) => onError(broadcastError(error, txHash)),
      );
      return cancel;
    });
    return txHash;
  }

  // Get transaction history of a given cashaddr
  async getHistory(
    cashaddr: string,
    fromHeight: number = 0,
    toHeight: number = -1,
  ): Promise<TxI[]> {
    return this.performRequest<TxI[]>("blockchain.address.get_history", [
      cashaddr,
      fromHeight,
      toHeight,
    ]);
  }

  // Get the minimum fee a low-priority transaction must pay in order to be accepted to the daemon's memory pool.
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

  // Wait for the next block or a block at given blockchain height.
  public async waitForBlock(height?: number): Promise<HexHeaderI> {
    if (this.currentHeight && !height) {
      height = this.currentHeight + 1;
    }
    return waitOnWatch<HexHeaderI>((done) =>
      this.watchBlocks((header) => {
        if (!height) {
          height = header.height + 1;
          return;
        }

        if (header.height >= height) done(header);
      }),
    );
  }

  // subscribe to notifications sent when new block is found, the block header is sent to callback
  async subscribeToHeaders(
    callback: (header: HexHeaderI) => unknown,
  ): Promise<CancelFn> {
    return this.subscribeRequest("blockchain.headers.subscribe", [], (data) =>
      callback(data[0]),
    );
  }

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

  async subscribeToDsproof(
    txHash: string,
    callback: (data: [txHash: string, dsproof: DsproofData | null]) => unknown,
  ): Promise<CancelFn> {
    return this.subscribeRequest(
      "blockchain.transaction.dsproof.subscribe",
      [txHash],
      callback,
    );
  }

  // Regtest only. Fulcrum's daemon.passthrough takes named params, which electrum-cash cannot send,
  // so this calls generatetoaddress on the node's own RPC, with the RPC_* settings of the regtest
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

  public async performRequest<T = unknown>(
    method: string,
    parameters: unknown[] = [],
  ): Promise<T> {
    await this.ready();
    return this.transport.request(method, parameters) as Promise<T>;
  }

  public async subscribeRequest(
    method: string,
    parameters: unknown[],
    callback: (data: any) => unknown,
  ): Promise<CancelFn> {
    await this.ready();

    // a callback's throw or rejection is reported, and it stays subscribed
    const unsubscribe = await this.transport.subscribe(
      method,
      parameters,
      (data) => runCallback(() => callback(data)),
    );
    this.subscriptions++;

    return async () => {
      await unsubscribe();
      this.subscriptions--;
    };
  }

  async ready(): Promise<void> {
    return this.connect();
  }

  async connect(): Promise<void> {
    await this.cache?.init();
    await this.transport.connect();
  }

  async disconnect(): Promise<boolean> {
    await this.headerCancelFn?.();
    await this.transport.close();
    return true;
  }
}

// A server's error response to a broadcast is a refusal; a timeout or a lost connection is not, as
// the transaction may still have reached the node
function broadcastError(error: unknown, txid: string): Error {
  if (serverErrorCode(error) === undefined) return toError(error);
  const { message } = error as Error;
  const { reason, code } = parseRejection(message);
  return new BroadcastRejectedError(message, {
    reason,
    code,
    txid,
    cause: error,
  });
}
