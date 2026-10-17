import {
  ConnectionStatus,
  ElectrumClient,
  type ElectrumClientEvents,
  type RPCNotification,
  type RPCParameter,
} from "@electrum-cash/network";
import { ElectrumWebSocket } from "@electrum-cash/web-socket";
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
  /** Milliseconds a request waits for its response. Default 30 000. */
  requestTimeout?: number;
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
const CLIENT_NAME = "bch-wallet-lib";
const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

// A broadcast that timed out may still have reached the node, and sending it again would then
// fail with "already known" for a transaction that went through
const NOT_RETRIED = new Set(["blockchain.transaction.broadcast"]);

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
 * subscriptions there. Only after close() does a connect() go through the list again.
 *
 * A request that times out or loses its connection is sent once more (a broadcast is not); an
 * error response from the server is not retried.
 */
export class ElectrumTransport implements Transport {
  private readonly servers: { name: string; client: Client }[];
  private readonly connectTimeout: number;
  private readonly requestTimeout: number;
  private client?: Client;
  private connecting?: Promise<void>;
  // Bumped by close(), so that work still under way does not connect again afterwards
  private epoch = 0;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    servers: ElectrumServer | ElectrumServer[],
    options: ElectrumTransportOptions = {},
  ) {
    const list = Array.isArray(servers) ? servers : [servers];
    if (list.length === 0) {
      throw new Error("At least one electrum server is required.");
    }
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.servers = list.map((server) => ({
      name: typeof server === "string" ? server : server.host,
      client: this.createClient(server),
    }));
  }

  async connect(): Promise<void> {
    if (this.client?.status === ConnectionStatus.CONNECTED) return;
    if (!this.connecting) {
      const connecting = this.establish().finally(() => {
        if (this.connecting === connecting) this.connecting = undefined;
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  async close(): Promise<void> {
    this.epoch++;
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
      if (subscription.latest) listener(subscription.latest);
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

    for (let tried = 1; ; tried++) {
      await this.connect();
      const client = this.client;
      if (!client || epoch !== this.epoch) {
        throw new Error("The electrum transport was closed.");
      }
      try {
        return await withTimeout(
          attempt(client),
          this.requestTimeout,
          () =>
            new ElectrumTimeoutError(
              `Electrum request '${method}' timed out after ${this.requestTimeout} ms.`,
            ),
        );
      } catch (error) {
        // electrum-cash gives a server's error response its error object as cause; an error without
        // one is the connection failing (lost, or not connected), which a fresh attempt can get past
        const fromServer = error instanceof Error && error.cause !== undefined;
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

  private createClient(server: ElectrumServer): Client {
    if (typeof server !== "string") {
      return new ElectrumClient(CLIENT_NAME, PROTOCOL_VERSION, server);
    }

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

    const socket = new ElectrumWebSocket(url.hostname, {
      port,
      encrypted,
      // Bounds the socket's open and version negotiation, and is how long a connection may stay
      // silent after a send before electrum-cash takes it for dead and reconnects
      timeoutInMilliSeconds: this.requestTimeout,
      // In a browser the flag ties the socket to page visibility and connectivity events, and in Node
      // it makes the socket verify TLS certificates. A wallet stays connected while hidden, and Node
      // must verify.
      enforceConsistentBrowserBehavior: typeof window === "undefined",
    });
    return new ElectrumClient(CLIENT_NAME, PROTOCOL_VERSION, socket);
  }
}

function subscriptionKey(method: string, params: unknown[]): string {
  return `${method}${JSON.stringify(params)}`;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
