import {
  ConnectionStatus,
  ElectrumClient,
  type ElectrumClientEvents,
  type RPCNotification,
  type RPCParameter,
} from "@electrum-cash/network";
import { ElectrumWebSocket } from "@electrum-cash/web-socket";
import { toError } from "../util/toError.js";
import { withTimeout } from "../util/withTimeout.js";
import { serverErrorCode } from "./errors.js";
import type { Transport, Unsubscribe } from "./Transport.js";

/** A server URL (`wss://host:port` or `ws://host:port`), or an electrum-cash socket set up by the caller. */
export type ElectrumServer = string | ElectrumSocket;
type ElectrumSocket = Exclude<
  ConstructorParameters<typeof ElectrumClient>[2],
  string
>;

export interface ElectrumTransportOptions {
  /** Milliseconds a server gets to connect and agree on the protocol version. Default 10 000. */
  connectTimeout?: number;
  /**
   * Milliseconds a request waits for its response. Default 30 000. A connection that stays silent
   * for half of it (or the connect timeout, if shorter) after a send is taken for dead and replaced,
   * so that a request that timed out is sent again on a fresh connection.
   */
  requestTimeout?: number;
}

/** FailoverTransport's view of a server's connection; not part of the exported options. */
export interface ElectrumTransportInternalOptions extends ElectrumTransportOptions {
  /**
   * Told when the connection is lost and when it is back, once per change. Not told about the first
   * connect, nor anything after close().
   */
  onConnectionChange?: (connected: boolean) => void;
}

/** A connect or request that got no answer within its timeout. */
export class ElectrumTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElectrumTimeoutError";
  }
}

type Client = ElectrumClient<ElectrumClientEvents>;

// Everything the provider uses is in 1.5, and electrum-cash refuses a server that negotiates any
// other version than the one asked for, so asking for 1.6 would shut out servers that stop at 1.5
const PROTOCOL_VERSION = "1.5";
const CLIENT_NAME = "@cashonize/bch-wallet-lib";
export const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

// A broadcast that timed out may still have reached the node, and sending it again would then
// fail with "already known" for a transaction that went through
const NOT_RETRIED = new Set(["blockchain.transaction.broadcast"]);

// electrum-cash only logs a subscription it failed to restore after a reconnect, and tries it again
// on the next reconnect at the earliest, so the transport makes it again itself, backing off
const RESTORE_RETRY_FIRST = 10_000;
const RESTORE_RETRY_MAX = 300_000;

interface Subscription {
  method: string;
  params: unknown[];
  listeners: Set<(data: unknown[]) => void>;
  /** The params of the newest notification, for listeners that join later. */
  latest?: unknown[];
  established: Promise<void>;
}

/**
 * Electrum transport over electrum-cash's ElectrumClient.
 *
 * With several servers, connect() tries them in the given order and the transport stays with the
 * first one that connects: electrum-cash reconnects to that server after a failure and restores its
 * subscriptions there; a subscription whose restore did not come back is made again, backing off
 * from 10 s to every 5 minutes, for as long as it exists. A closed transport refuses to connect
 * again; moving to another server is FailoverTransport's job.
 *
 * A request that times out or loses its connection is sent once more (a broadcast is not), and
 * a late answer to the first attempt is taken as well; an error response from the server is not
 * retried.
 */
export class ElectrumTransport implements Transport {
  private readonly servers: { name: string; client: Client }[];
  private readonly connectTimeout: number;
  private readonly requestTimeout: number;
  private readonly onConnectionChange?: (connected: boolean) => void;
  private client?: Client;
  private connecting?: Promise<void>;
  // Bumped by close(), so that work still under way does not connect again afterwards
  private epoch = 0;
  private closed = false;
  private readonly subscriptions = new Map<string, Subscription>();
  // The subscriptions the last reconnect has not delivered a status for yet, and the timer that
  // makes them again; a new reconnect starts a new round
  private unrestored = new Set<string>();
  private restoreRound = 0;
  private restoreTimer?: ReturnType<typeof setTimeout>;

  constructor(
    servers: ElectrumServer | ElectrumServer[],
    options: ElectrumTransportInternalOptions = {},
  ) {
    const list = Array.isArray(servers) ? servers : [servers];
    if (list.length === 0) {
      throw new Error("At least one electrum server is required.");
    }
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.onConnectionChange = options.onConnectionChange;
    this.servers = list.map((server) => ({
      name: typeof server === "string" ? server : server.host,
      client: this.createClient(server),
    }));
  }

  /** Whether the connection is up right now. */
  get connected(): boolean {
    return this.client?.status === ConnectionStatus.CONNECTED;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("The electrum transport was closed.");
    if (this.client?.status === ConnectionStatus.CONNECTED) return;
    if (!this.connecting) {
      const connecting = this.establish().finally(() => {
        if (this.connecting === connecting) this.connecting = undefined;
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  /**
   * Ends the connection and every subscription, for good: a closed transport refuses to connect
   * again, so a request still holding it fails instead of reopening a connection to a server the
   * caller has left. Waits for a connect attempt still under way, which for a server given by URL
   * gives up within about the connect timeout.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.epoch++;
    clearTimeout(this.restoreTimer);
    this.unrestored.clear();
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    this.subscriptions.clear();
    // Also drops electrum-cash's own subscriptions and listeners, so nothing is restored later
    await client?.disconnect(true);
  }

  async request(method: string, params: unknown[] = []): Promise<unknown> {
    return this.withRetry(method, async (client) => {
      const response = await client.request(
        method,
        ...(params as RPCParameter[]),
      );
      if (response instanceof Error) throw response;
      return response;
    });
  }

  async subscribe(
    method: string,
    params: unknown[],
    onData: (data: unknown[]) => void,
  ): Promise<Unsubscribe> {
    const key = subscriptionKey(method, params);
    // Its own function per call, so the same callback subscribed twice is also removed twice
    const listener = (data: unknown[]) => onData(data);

    let subscription = this.subscriptions.get(key);
    if (subscription) {
      // One server subscription per method and params: a listener that joins gets the newest status
      await subscription.established;
      // It may have ended while this call waited
      if (this.subscriptions.get(key) !== subscription) {
        return this.subscribe(method, params, onData);
      }
      subscription.listeners.add(listener);
      if (subscription.latest) {
        // As in route(): a throwing listener stays subscribed, and the caller gets its Unsubscribe
        try {
          listener(subscription.latest);
        } catch (error) {
          console.error(error);
        }
      }
    } else {
      subscription = {
        method,
        params,
        listeners: new Set([listener]),
        established: Promise.resolve(),
      };
      this.subscriptions.set(key, subscription);
      subscription.established = this.establishSubscription(key, subscription);
      await subscription.established;
    }

    const current = subscription;
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      if (this.subscriptions.get(key) !== current) return;
      this.subscriptions.delete(key);
      this.unrestored.delete(key);
      // The listener is gone either way, so the server's confirmation is not waited for
      this.client
        ?.unsubscribe(method, ...(params as RPCParameter[]))
        .catch(() => {});
    };
  }

  private async establish(): Promise<void> {
    if (this.client) {
      await this.connectWithin(this.client, this.client.hostIdentifier);
      return;
    }

    const epoch = this.epoch;
    const failures: string[] = [];
    for (const { name, client } of this.servers) {
      try {
        await this.connectWithin(client, name);
      } catch (error) {
        failures.push((error as Error).message);
        // electrum-cash keeps retrying a server that failed to connect, until it is disconnected
        client.disconnect(true).catch(() => {});
        continue;
      }
      if (epoch !== this.epoch) {
        client.disconnect(true).catch(() => {});
        throw new Error("The electrum transport was closed while connecting.");
      }
      client.on("notification", this.route);
      // Registered after the first connect, so it runs on reconnects only, before any restore is sent
      client.on("connected", this.startRestoreRound);
      const onChange = this.onConnectionChange;
      if (onChange) {
        // electrum-cash also emits 'disconnected' when a request's own connect fails while the
        // server is down, so only changes are told; disconnect(true) in close() removes these too
        let up = true;
        client.on("connected", () => {
          if (up) return;
          up = true;
          onChange(true);
        });
        client.on("disconnected", () => {
          if (!up) return;
          up = false;
          onChange(false);
        });
      }
      this.client = client;
      return;
    }
    throw new Error(
      `Could not connect to an electrum server (${failures.join("; ")}).`,
    );
  }

  private async connectWithin(client: Client, name: string): Promise<void> {
    await withTimeout(
      client.connect(),
      this.connectTimeout,
      () =>
        new ElectrumTimeoutError(
          `Connecting to '${name}' timed out after ${this.connectTimeout} ms.`,
        ),
    );
  }

  private async withRetry<T>(
    method: string,
    attempt: (client: Client) => Promise<T>,
  ): Promise<T> {
    const epoch = this.epoch;
    let attempts = 2;
    if (NOT_RETRIED.has(method)) attempts = 1;

    let earlier: Promise<T> | undefined;
    for (let tried = 1; ; tried++) {
      await this.connect();
      const client = this.client;
      if (!client || epoch !== this.epoch) {
        throw new Error("The electrum transport was closed.");
      }
      let answer = attempt(client);
      // A slow server may still answer the attempt that timed out, and that answer is as good
      if (earlier) answer = firstAnswer(earlier, answer);
      earlier = answer;
      try {
        return await withTimeout(
          answer,
          this.requestTimeout,
          () =>
            new ElectrumTimeoutError(
              `Electrum request '${method}' timed out after ${this.requestTimeout} ms.`,
            ),
        );
      } catch (error) {
        // A server's error response is told by its JSON-RPC code, which electrum-cash 4.4 puts on
        // the error's cause and 4.5's RpcError on the error itself; an error without one is the
        // connection failing (lost, or not connected), which a fresh attempt can get past
        const fromServer = serverErrorCode(error) !== undefined;
        if (fromServer || tried >= attempts || epoch !== this.epoch) {
          throw toError(error);
        }
      }
    }
  }

  private async establishSubscription(
    key: string,
    subscription: Subscription,
  ): Promise<void> {
    const { method, params } = subscription;
    try {
      // electrum-cash delivers the current status as a notification, which route() hands out
      await this.withRetry(method, (client) =>
        client.subscribe(method, ...(params as RPCParameter[])),
      );
    } catch (error) {
      if (this.subscriptions.get(key) === subscription) {
        this.subscriptions.delete(key);
        // electrum-cash keeps a subscription whose request did not get through, to restore it on
        // the next connect
        this.client
          ?.unsubscribe(method, ...(params as RPCParameter[]))
          .catch(() => {});
      }
      throw error;
    }
  }

  // Electrum notifications carry the subscription's params followed by the status:
  // [address, status], [txHash, height], [header]
  private route = (notification: RPCNotification): void => {
    const params: unknown[] = notification.params ?? [];
    const key = subscriptionKey(notification.method, params.slice(0, -1));
    const subscription = this.subscriptions.get(key);
    if (!subscription) return;
    // A restored subscription delivers its status; so does one the server pushes, which it holds
    this.unrestored.delete(key);
    subscription.latest = params;
    for (const listener of subscription.listeners) {
      // A throwing listener must not reach electrum-cash, which would drop the rest of the message
      try {
        listener(params);
      } catch (error) {
        console.error(error);
      }
    }
  };

  private startRestoreRound = (): void => {
    clearTimeout(this.restoreTimer);
    const round = ++this.restoreRound;
    this.unrestored = new Set(this.subscriptions.keys());
    // electrum-cash's own restore gets a request's timeout to come back
    this.scheduleRestore(round, this.requestTimeout, RESTORE_RETRY_FIRST);
  };

  private scheduleRestore(round: number, wait: number, next: number): void {
    if (this.unrestored.size === 0) return;
    this.restoreTimer = setTimeout(() => {
      this.restoreUnrestored(round)
        .catch(() => {})
        .finally(() => {
          if (round !== this.restoreRound || this.closed) return;
          this.scheduleRestore(
            round,
            next,
            Math.min(next * 2, RESTORE_RETRY_MAX),
          );
        });
    }, wait);
  }

  // One subscription at a time, as a server that refused a restore may be limiting how fast it is asked
  private async restoreUnrestored(round: number): Promise<void> {
    for (const key of this.unrestored) {
      // While the connection is lost there is nothing to send; its reconnect starts a new round
      if (round !== this.restoreRound || this.closed || !this.connected) {
        return;
      }
      const subscription = this.subscriptions.get(key);
      if (!subscription || !this.unrestored.has(key)) continue;
      const { method, params } = subscription;
      try {
        // Like establishSubscription; route() takes the key out with the status it delivers
        await this.withRetry(method, (client) =>
          client.subscribe(method, ...(params as RPCParameter[])),
        );
      } catch {
        // stays in unrestored for the next attempt
        continue;
      }
      // Ended while it was made again, which put it back in electrum-cash's list to restore
      if (!this.subscriptions.has(key)) {
        this.client
          ?.unsubscribe(method, ...(params as RPCParameter[]))
          .catch(() => {});
      }
    }
  }

  private createClient(server: ElectrumServer): Client {
    if (typeof server !== "string") {
      return new ElectrumClient(CLIENT_NAME, PROTOCOL_VERSION, server);
    }

    const { hostname, port, encrypted } = parseServerUrl(server);
    const socket = new ElectrumWebSocket(hostname, {
      port,
      encrypted,
      // Bounds the socket's open and version negotiation, and is how long a connection may stay
      // silent after a send before electrum-cash takes it for dead and reconnects. Shorter than a
      // request's timeout, so that the retry finds a fresh connection rather than the closing one;
      // and no longer than the connect timeout, as an attempt holds electrum-cash's connection lock
      // (which close() waits for) until the socket gives up.
      timeoutInMilliSeconds: Math.min(
        this.connectTimeout,
        this.requestTimeout / 2,
      ),
      // In a browser the flag ties the socket to page visibility and connectivity events, and in Node
      // it makes the socket verify TLS certificates. A wallet stays connected while hidden, and Node
      // must verify.
      enforceConsistentBrowserBehavior: typeof window === "undefined",
    });
    return new ElectrumClient(CLIENT_NAME, PROTOCOL_VERSION, socket);
  }
}

/** A server URL's parts; throws for anything but a plain `ws://` or `wss://` host and port. */
export function parseServerUrl(server: string): {
  hostname: string;
  port: number;
  encrypted: boolean;
} {
  const url = new URL(server);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(
      `Unsupported electrum server URL '${server}': only wss:// and ws:// are supported.`,
    );
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new Error(
      `Unsupported electrum server URL '${server}': only a host and port are supported.`,
    );
  }
  const encrypted = url.protocol === "wss:";
  let port = encrypted ? 443 : 80;
  if (url.port) port = Number(url.port);
  return { hostname: url.hostname, port, encrypted };
}

function subscriptionKey(method: string, params: unknown[]): string {
  return `${method}${JSON.stringify(params)}`;
}

// Settles as `latest` does, unless `earlier` resolves first
function firstAnswer<T>(earlier: Promise<T>, latest: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    earlier.then(resolve, () => {});
    latest.then(resolve, reject);
  });
}
