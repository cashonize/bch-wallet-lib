import type { HexHeaderI } from "../interface.js";
import { decodeHeader } from "../util/header.js";
import { Limiter } from "../util/mapConcurrent.js";
import { getTransactionHash } from "../util/transaction.js";
import {
  DEFAULT_CONNECT_TIMEOUT,
  ElectrumTransport,
  parseServerUrl,
  type ElectrumServer,
  type ElectrumTransportOptions,
} from "./ElectrumTransport.js";
import { ElectrumConnectError, serverErrorCode } from "./errors.js";
import type { ChainCheck } from "./registry.js";
import type { Transport, Unsubscribe } from "./Transport.js";

export interface FailoverTransportOptions extends ElectrumTransportOptions {
  /**
   * Milliseconds a lost connection gets to come back before the next server is tried. Default:
   * electrum-cash's 5 s reconnect delay plus the connect timeout, so that one reconnect attempt
   * fits, which is all a backgrounded Safari/iOS tab whose socket was killed needs.
   */
  gracePeriod?: number;
  /**
   * A server whose newest tip is older than this many seconds is left for the next one, and skipped
   * as a candidate (at startup it is still taken when no server has a fresher tip). Checked when a
   * tip arrives and every quarter of it (at least every grace period); a stale server is left at
   * most once per check interval. Off by default.
   */
  staleTipSeconds?: number;
  /** Whether the device is online; default `navigator.onLine`, true where there is no navigator. */
  isOnline?: () => boolean;
  /** Told the server (as given) every time the transport settles on one: at connect and on a switch. */
  onServerChange?: (server: string) => void;
  /**
   * Told when the connection of the server in use is lost and when it is back, once per change; a
   * switch to another server counts as back. Not told about the first connect.
   */
  onConnectionChange?: (connected: boolean) => void;
}

/** @internal The network's chain, which createFailoverProvider passes from the registry */
export interface FailoverTransportInternalOptions extends FailoverTransportOptions {
  chain?: ChainCheck;
}

// electrum-cash's delay before it reconnects a lost connection
const ELECTRUM_CASH_RECONNECT_DELAY = 5_000;
// A candidate further behind the highest tip seen has not caught up (Electron Cash's lag rule)
const MAX_TIP_LAG = 1;
// As setProvider: an HD wallet holds a subscription per watched address
const MOVE_CONCURRENCY = 50;
const BROADCAST = "blockchain.transaction.broadcast";

interface Server {
  name: string;
  transport: ElectrumTransport;
}

interface Entry {
  method: string;
  params: unknown[];
  listener: (data: unknown[]) => void;
  // One per server it is subscribed on: the current one, plus a candidate while moving to it
  subs: Map<ElectrumTransport, Unsubscribe>;
}

/**
 * Electrum transport over an ordered list of servers, one single-server ElectrumTransport at a
 * time, each closed for good once left. A candidate's tip is checked before any subscription moves
 * there, so a server learns the subscribed addresses only once it is taken. With one server it
 * never contacts another.
 */
export class FailoverTransport implements Transport {
  private readonly servers: ElectrumServer[];
  private readonly options: FailoverTransportInternalOptions;
  private readonly gracePeriod: number;
  private readonly isOnline: () => boolean;
  private current?: Server;
  // The server a switch is leaving, until the switch ends: close() must reach it too
  private leaving?: Server;
  private starting?: Promise<void>;
  private switching?: Promise<boolean>;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private highestTip?: number;
  // The newest tip of the server in use, which staleTipSeconds is checked against
  private lastTip?: HexHeaderI;
  private staleTimer?: ReturnType<typeof setInterval>;
  private nextStaleAttempt = 0;
  // Whether the server in use was last reported connected (see onConnectionChange)
  private reportedUp = true;
  private readonly entries = new Set<Entry>();
  // One settle at a time per server: two at once would subscribe an entry twice there
  private readonly settling = new Map<ElectrumTransport, Promise<void>>();
  // Candidates connected but not yet in use, closed by close()
  private readonly probing = new Set<ElectrumTransport>();

  constructor(
    servers: ElectrumServer | ElectrumServer[],
    options: FailoverTransportInternalOptions = {},
  ) {
    const list = Array.isArray(servers) ? servers : [servers];
    if (list.length === 0) {
      throw new Error("At least one electrum server is required.");
    }
    // a bad URL is the caller's mistake, not an unreachable server, so it throws here
    for (const server of list) {
      if (typeof server === "string") parseServerUrl(server);
    }
    this.servers = list;
    this.options = options;
    this.gracePeriod =
      options.gracePeriod ??
      ELECTRUM_CASH_RECONNECT_DELAY +
        (options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT);
    this.isOnline = options.isOnline ?? deviceOnline;
  }

  /** The server in use, as it was given; undefined until connected. */
  get server(): string | undefined {
    return this.current?.name;
  }

  async connect(): Promise<void> {
    const transport = await this.currentTransport();
    await transport.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.graceTimer);
    clearInterval(this.staleTimer);
    const transports = new Set(this.probing);
    if (this.current) transports.add(this.current.transport);
    if (this.leaving) transports.add(this.leaving.transport);
    this.current = undefined;
    this.leaving = undefined;
    this.probing.clear();
    this.entries.clear();
    await Promise.all([...transports].map((transport) => transport.close()));
  }

  async request(method: string, params: unknown[] = []): Promise<unknown> {
    const transport = await this.currentTransport();
    let result: unknown;
    try {
      result = await transport.request(method, params);
    } catch (error) {
      const left = !this.closed && this.current?.transport !== transport;
      if (!left || method === BROADCAST || serverErrorCode(error) !== undefined)
        throw error;
      const next = await this.currentTransport();
      result = await next.request(method, params);
    }
    if (
      method === "blockchain.headers.get_tip" ||
      method === "blockchain.headers.subscribe"
    ) {
      this.noteTip(result);
    }
    return result;
  }

  async subscribe(
    method: string,
    params: unknown[],
    onData: (data: unknown[]) => void,
  ): Promise<Unsubscribe> {
    const entry: Entry = {
      method,
      params,
      listener: (data) => {
        if (method === "blockchain.headers.subscribe") this.noteTip(data[0]);
        onData(data);
      },
      subs: new Map(),
    };
    for (;;) {
      const transport = await this.currentTransport();
      let unsubscribe: Unsubscribe;
      try {
        unsubscribe = await transport.subscribe(method, params, entry.listener);
      } catch (error) {
        // made on a server that a switch left meanwhile, so it is made again on the new one
        if (this.closed || this.current?.transport === transport) throw error;
        continue;
      }
      if (this.current?.transport !== transport) {
        unsubscribe().catch(() => {});
        continue;
      }
      entry.subs.set(transport, unsubscribe);
      this.entries.add(entry);
      break;
    }
    return async () => {
      if (!this.entries.delete(entry)) return;
      const subs = [...entry.subs.values()];
      entry.subs.clear();
      await Promise.all(subs.map((unsubscribe) => unsubscribe()));
    };
  }

  private async currentTransport(): Promise<ElectrumTransport> {
    if (this.closed) throw new Error("The electrum transport was closed.");
    if (!this.current) {
      if (!this.starting) {
        const starting = this.start().finally(() => {
          if (this.starting === starting) this.starting = undefined;
        });
        this.starting = starting;
      }
      await this.starting;
    }
    if (!this.current) throw new Error("The electrum transport was closed.");
    return this.current.transport;
  }

  private async start(): Promise<void> {
    const failures = await this.walk();
    if (failures) throw new ElectrumConnectError(failures);
  }

  // Resolves to whether the transport left its server. A server lost is left only while it stays
  // lost; one on a stale tip is left although it is connected.
  private failover(reason: "lost" | "stale"): Promise<boolean> {
    if (!this.switching) {
      const switching = this.switchServer(reason).finally(() => {
        if (this.switching === switching) this.switching = undefined;
      });
      this.switching = switching;
    }
    return this.switching;
  }

  private async switchServer(reason: "lost" | "stale"): Promise<boolean> {
    const leaving = this.current;
    if (!leaving || this.closed || this.servers.length < 2) return false;
    this.leaving = leaving;
    try {
      await this.walk({ server: leaving, unlessBack: reason === "lost" });
    } finally {
      if (this.leaving === leaving) this.leaving = undefined;
    }
    if (this.closed) return false;
    if (this.current === leaving) {
      // subscriptions made on a candidate that was given up come back to the server still in use
      this.settle(leaving.transport).catch(() => {});
      return false;
    }
    return true;
  }

  /**
   * Takes the first server of the list that passes the checks, skipping the one being left.
   * Resolves to the reasons the servers were passed over when none was taken, undefined otherwise
   * (also when the server being left came back meanwhile, with `unlessBack`).
   */
  private async walk(from?: {
    server: Server;
    unlessBack: boolean;
  }): Promise<Failure[] | undefined> {
    const leaving = from?.server;
    const isBack = () => from?.unlessBack && leaving?.transport.connected;
    const failures: Failure[] = [];
    // At startup a reachable server on a stale tip is taken when no server has a fresher one, so a
    // device clock that is off cannot leave the wallet without a server
    let fallback: { server: Server; tip: HexHeaderI } | undefined;
    let tried = 0;
    // A lost server gets one reconnect of its own first: electrum-cash's next retry may still be
    // seconds away when the device comes back online, and another server answering first would
    // then get the wallet's subscriptions while its own server is reachable again
    if (from?.unlessBack && leaving) {
      await leaving.transport.connect().catch(() => {});
      if (this.closed || isBack()) return undefined;
    }
    for (const entry of this.servers) {
      if (this.closed) break;
      const name = serverName(entry);
      if (name === leaving?.name) continue;
      if (isBack()) return undefined;
      // a device that went offline fails every server alike: walking on would hand the wallet to
      // whichever server answers first once the network is back
      if (tried > 0 && !this.isOnline()) {
        failures.push({ server: undefined, reason: "the device is offline" });
        break;
      }
      tried++;
      let probed: { server: Server; tip: HexHeaderI };
      try {
        probed = await this.probe(entry, name);
      } catch (error) {
        failures.push({ server: name, reason: (error as Error).message });
        continue;
      }
      if (this.closed) break;
      if (this.isStale(probed.tip)) {
        failures.push({ server: name, reason: "its tip is stale" });
        if (!leaving && !fallback) fallback = probed;
        else this.abandon(probed.server.transport);
        continue;
      }
      if (isBack()) {
        this.abandon(probed.server.transport);
        return undefined;
      }
      if (await this.take(probed.server, probed.tip, leaving)) {
        if (fallback) this.abandon(fallback.server.transport);
        return undefined;
      }
      failures.push({
        server: name,
        reason: "the subscriptions could not be moved there",
      });
      // it was shown the subscriptions already; walking on would show them to yet another operator
      // within one switch, so the next server waits for the next grace period
      break;
    }
    if (fallback && !this.closed) {
      this.nextStaleAttempt = Date.now() + this.staleInterval();
      if (await this.take(fallback.server, fallback.tip, leaving))
        return undefined;
    }
    return failures;
  }

  // Connects to a candidate and checks its tip and chain; no subscription is made there yet
  private async probe(
    entry: ElectrumServer,
    name: string,
  ): Promise<{ server: Server; tip: HexHeaderI }> {
    const transport: ElectrumTransport = new ElectrumTransport(entry, {
      connectTimeout: this.options.connectTimeout,
      requestTimeout: this.options.requestTimeout,
      onConnectionChange: (connected) =>
        this.connectionChanged(transport, connected),
    });
    this.probing.add(transport);
    try {
      await transport.connect();
      const tip = (await transport.request(
        "blockchain.headers.get_tip",
      )) as HexHeaderI;
      if (typeof tip?.height !== "number") {
        throw new Error("it answered the tip request without a height");
      }
      if (
        this.highestTip !== undefined &&
        tip.height < this.highestTip - MAX_TIP_LAG
      ) {
        throw new Error(
          `its tip ${tip.height} is behind the ${this.highestTip} seen before`,
        );
      }
      if (this.options.chain) {
        await checkChain(transport, this.options.chain, tip.height);
      }
      return { server: { name, transport }, tip };
    } catch (error) {
      this.abandon(transport);
      throw error;
    }
  }

  // Makes the candidate the server in use and moves every subscription there; if one cannot be
  // made, the candidate is given up and the server being left stays in use
  private async take(
    server: Server,
    tip: HexHeaderI,
    leaving?: Server,
  ): Promise<boolean> {
    // requests go to the candidate already, so the fetches its statuses cause are answered by it
    this.current = server;
    try {
      await this.settle(server.transport);
    } catch {
      if (this.closed) return false;
      this.current = leaving;
      this.abandon(server.transport);
      return false;
    }
    if (this.closed) return false;
    for (const entry of this.entries) {
      for (const transport of entry.subs.keys()) {
        if (transport !== server.transport) entry.subs.delete(transport);
      }
    }
    this.probing.delete(server.transport);
    leaving?.transport.close().catch(() => {});
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.highestTip = Math.max(this.highestTip ?? 0, tip.height);
    this.lastTip = tip;
    if (this.options.staleTipSeconds !== undefined && this.servers.length > 1) {
      this.staleTimer ??= setInterval(
        () => this.checkStale(),
        this.staleInterval(),
      );
    }
    try {
      this.options.onServerChange?.(server.name);
    } catch (error) {
      console.error(error);
    }
    this.report(true);
    return true;
  }

  private settle(target: ElectrumTransport): Promise<void> {
    const previous = this.settling.get(target) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.settleNow(target));
    this.settling.set(target, next);
    const forget = () => {
      if (this.settling.get(target) === next) this.settling.delete(target);
    };
    next.then(forget, forget);
    return next;
  }

  // Subscribes every entry that is not yet subscribed on the target, also those added meanwhile
  private async settleNow(target: ElectrumTransport): Promise<void> {
    const limiter = new Limiter(MOVE_CONCURRENCY);
    for (;;) {
      const pending = [...this.entries].filter(
        (entry) => !entry.subs.has(target),
      );
      if (pending.length === 0) return;
      const results = await Promise.allSettled(
        pending.map((entry) =>
          limiter.run(async () => {
            const unsubscribe = await target.subscribe(
              entry.method,
              entry.params,
              entry.listener,
            );
            if (this.entries.has(entry)) entry.subs.set(target, unsubscribe);
            else await unsubscribe();
          }),
        ),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    }
  }

  private abandon(transport: ElectrumTransport): void {
    this.probing.delete(transport);
    for (const entry of this.entries) entry.subs.delete(transport);
    transport.close().catch(() => {});
  }

  private connectionChanged(
    transport: ElectrumTransport,
    connected: boolean,
  ): void {
    if (transport !== this.current?.transport) return;
    this.report(connected);
    if (this.servers.length < 2) return;
    if (connected) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      // subscriptions a given-up switch handed back while this server was down are made now
      if (!this.switching) this.settle(transport).catch(() => {});
      return;
    }
    this.graceTimer ??= setTimeout(
      () => void this.afterGrace(),
      this.gracePeriod,
    );
  }

  private async afterGrace(): Promise<void> {
    this.graceTimer = undefined;
    const current = this.current;
    if (this.closed || !current || current.transport.connected) return;
    // offline, electrum-cash keeps reconnecting to the same server, which is all that is wanted
    if (this.isOnline() && (await this.failover("lost"))) return;
    // checked again a grace period later, while the server stays unreachable
    if (this.closed || this.current !== current || current.transport.connected)
      return;
    this.graceTimer ??= setTimeout(
      () => void this.afterGrace(),
      this.gracePeriod,
    );
  }

  private report(connected: boolean): void {
    if (this.reportedUp === connected) return;
    this.reportedUp = connected;
    try {
      this.options.onConnectionChange?.(connected);
    } catch (error) {
      console.error(error);
    }
  }

  private noteTip(header: unknown): void {
    const tip = header as HexHeaderI | undefined;
    if (typeof tip?.height !== "number") return;
    this.highestTip = Math.max(this.highestTip ?? 0, tip.height);
    this.lastTip = tip;
    this.checkStale();
  }

  // A server that stopped following the chain sends no new tip, so the last one is also checked on
  // a timer; a stale server is left at most once per interval, as each try walks the whole list
  private checkStale(): void {
    const tip = this.lastTip;
    if (this.closed || !tip || !this.isStale(tip)) return;
    if (Date.now() < this.nextStaleAttempt) return;
    this.nextStaleAttempt = Date.now() + this.staleInterval();
    void this.failover("stale");
  }

  private staleInterval(): number {
    const seconds = this.options.staleTipSeconds ?? 0;
    return Math.max(this.gracePeriod, (seconds * 1000) / 4);
  }

  private isStale(tip: HexHeaderI): boolean {
    const { staleTipSeconds } = this.options;
    if (staleTipSeconds === undefined) return false;
    let timestamp: number;
    try {
      timestamp = decodeHeader(tip).timestamp;
    } catch {
      return false;
    }
    return Date.now() / 1000 - timestamp > staleTipSeconds;
  }
}

type Failure = ElectrumConnectError["failures"][number];

function serverName(server: ElectrumServer): string {
  return typeof server === "string" ? server : server.host;
}

function deviceOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

// A server on another chain is refused before it learns any address: one sharing the genesis
// (chipnet and testnet4) differs at the checkpoint, so that is checked when there is one
async function checkChain(
  transport: ElectrumTransport,
  chain: ChainCheck,
  tipHeight: number,
): Promise<void> {
  const checkpoint = chain.checkpoint;
  if (!checkpoint) {
    const features = (await transport.request("server.features")) as
      | { genesis_hash?: unknown }
      | undefined;
    const genesis = features?.genesis_hash;
    if (
      typeof genesis !== "string" ||
      genesis.toLowerCase() !== chain.genesisHash
    ) {
      throw new Error("its genesis block is another chain's");
    }
    return;
  }
  if (tipHeight < checkpoint.height) {
    throw new Error(
      `its tip ${tipHeight} is below the checkpoint at ${checkpoint.height}`,
    );
  }
  const header = await transport.request("blockchain.block.header", [
    checkpoint.height,
  ]);
  // a block hash is the same double sha256 as a transaction's
  if (
    typeof header !== "string" ||
    (await getTransactionHash(header)) !== checkpoint.hash
  ) {
    throw new Error(
      `its block at height ${checkpoint.height} is another chain's`,
    );
  }
}
