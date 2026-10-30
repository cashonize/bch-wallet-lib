import { EventEmitter } from "node:events";
import { delay } from "../src/util/delay.js";

export type Reply =
  | { result: unknown }
  | { error: { code: number; message: string } };
export type Handler = (params: unknown[], call: number) => Reply | undefined;

/**
 * An electrum-cash socket with a scripted Electrum server behind it, so that the transport runs on
 * the real ElectrumClient. A handler returning undefined leaves the request unanswered.
 */
export class FakeServer extends EventEmitter {
  host: string;
  options = { port: 50004, encrypted: true, timeoutInMilliSeconds: 60_000 };
  isConnecting = false;
  isDisconnecting = false;
  connected = false;
  connects = 0;
  hangOnConnect = false;
  // Takes every write and answers none, as a connection the OS dropped without telling the app
  // (iOS / Safari in the background); closing it then waits out the unanswered closing handshake
  silent = false;
  closing = false;
  received: { id: unknown; method: string; params: unknown[] }[] = [];
  handlers = new Map<string, Handler>();

  constructor(host = "fake.example") {
    super();
    this.host = host;
  }

  get isConnected() {
    return this.connected;
  }

  get isDisconnected() {
    return !this.connected;
  }

  async connect(): Promise<void> {
    this.connects++;
    if (this.hangOnConnect) {
      // ElectrumWebSocket gives up after its timeout
      await delay(this.options.timeoutInMilliSeconds);
      this.emit("disconnected");
      throw new Error("socket timed out");
    }
    this.connected = true;
    this.emit("connected");
  }

  async disconnect(): Promise<void> {
    if (!this.connected || this.closing) return;
    if (this.silent) {
      this.closing = true;
      await delay(100);
      this.closing = false;
      this.silent = false;
    }
    this.connected = false;
    this.emit("disconnected");
  }

  // The server closes the connection
  drop(): void {
    this.connected = false;
    this.emit("disconnected");
  }

  async write(data: string): Promise<boolean> {
    if (!this.connected || this.closing) throw new Error("not connected");
    if (this.silent) return true;
    const { id, method, params } = JSON.parse(data);
    if (method === "server.version") {
      this.reply({ id, result: ["fake 1.0", "1.5"] });
      return true;
    }
    if (method === "server.ping") {
      this.reply({ id, result: null });
      return true;
    }
    this.received.push({ id, method, params });
    const handler = this.handlers.get(method);
    const call = this.calls(method).length;
    const reply = handler?.(params, call);
    if (reply) this.reply({ id, ...reply });
    return true;
  }

  respond(id: unknown, reply: Reply): void {
    this.reply({ id, ...reply });
  }

  notify(method: string, params: unknown[]): void {
    this.reply({ method, params });
  }

  calls(method: string) {
    return this.received.filter((request) => request.method === method);
  }

  private reply(message: object): void {
    setTimeout(() => {
      if (this.connected) this.emit("data", `${JSON.stringify(message)}\n`);
    }, 0);
  }
}
