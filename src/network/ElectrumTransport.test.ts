import { EventEmitter } from "node:events";
import { delay } from "../util/delay.js";
import { getTransactionHash } from "../util/transaction.js";
import ElectrumNetworkProvider from "./ElectrumNetworkProvider.js";
import {
  ElectrumTimeoutError,
  ElectrumTransport,
  type ElectrumServer,
} from "./ElectrumTransport.js";
import { BroadcastRejectedError } from "./errors.js";

type Reply = { result: unknown } | { error: { code: number; message: string } };
type Handler = (params: unknown[], call: number) => Reply | undefined;

/**
 * An electrum-cash socket with a scripted Electrum server behind it, so that the transport runs on
 * the real ElectrumClient. A handler returning undefined leaves the request unanswered.
 */
class FakeServer extends EventEmitter {
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

const asServer = (fake: FakeServer) => fake as unknown as ElectrumServer;

// A server given by URL gets a FakeServer in place of its ElectrumWebSocket, with the options the
// transport chose for it
const urlSockets = vi.hoisted(() => ({
  created: [] as unknown[],
  create: (_host: string): unknown => undefined,
}));
vi.mock("@electrum-cash/web-socket", () => ({
  ElectrumWebSocket: function (host: string, options: object) {
    const socket = urlSockets.create(host) as { options: object };
    socket.options = options;
    urlSockets.created.push(socket);
    return socket;
  },
}));
urlSockets.create = (host) => new FakeServer(host);
const lastUrlSocket = () => urlSockets.created.at(-1) as FakeServer;

const addressA = "bitcoincash:qrfdnsxr2lljh0ej2w6dvqx9mgdmasnlpgk99t8ch4";
const addressB = "bitcoincash:qz5ggc6fwvf0ec2l9w6yngdw7tjqnsehhvf7dmqwyk";

let transport: ElectrumTransport;

afterEach(async () => {
  await transport?.close();
});

describe("ElectrumTransport requests", () => {
  test("sends positional params and resolves with the result", async () => {
    const fake = new FakeServer();
    fake.handlers.set("blockchain.transaction.get", ([txid]) => ({
      result: `hex of ${String(txid)}`,
    }));
    transport = new ElectrumTransport(asServer(fake));

    const result = await transport.request("blockchain.transaction.get", [
      "ab".repeat(32),
      false,
    ]);

    expect(result).toBe(`hex of ${"ab".repeat(32)}`);
    expect(fake.calls("blockchain.transaction.get")[0].params).toEqual([
      "ab".repeat(32),
      false,
    ]);
  });

  test("rejects a server error with an Error, without sending it again", async () => {
    const fake = new FakeServer();
    fake.handlers.set("blockchain.transaction.get", () => ({
      error: { code: 2, message: "No such mempool or blockchain transaction" },
    }));
    transport = new ElectrumTransport(asServer(fake));

    const request = transport.request("blockchain.transaction.get", ["00"]);

    await expect(request).rejects.toBeInstanceOf(Error);
    await expect(request).rejects.toThrow(
      "No such mempool or blockchain transaction",
    );
    expect(fake.calls("blockchain.transaction.get")).toHaveLength(1);
  });

  test("rejects an unanswered request with an ElectrumTimeoutError, after sending it again", async () => {
    const fake = new FakeServer();
    transport = new ElectrumTransport(asServer(fake), { requestTimeout: 50 });

    const request = transport.request("blockchain.address.get_history", [
      addressA,
    ]);

    await expect(request).rejects.toBeInstanceOf(ElectrumTimeoutError);
    await expect(request).rejects.toThrow(
      "'blockchain.address.get_history' timed out after 50 ms",
    );
    const sent = fake.calls("blockchain.address.get_history");
    expect(sent).toHaveLength(2);
    expect(sent[0].id).not.toBe(sent[1].id);
  });

  test("resolves with the answer to the re-sent request", async () => {
    const fake = new FakeServer();
    fake.handlers.set("blockchain.address.get_history", (_params, call) =>
      call === 2 ? { result: [] } : undefined,
    );
    transport = new ElectrumTransport(asServer(fake), { requestTimeout: 50 });

    const result = await transport.request("blockchain.address.get_history", [
      addressA,
    ]);

    expect(result).toEqual([]);
    expect(fake.calls("blockchain.address.get_history")).toHaveLength(2);
  });

  test("resolves with a late answer to the request that timed out", async () => {
    const fake = new FakeServer();
    transport = new ElectrumTransport(asServer(fake), { requestTimeout: 50 });

    const request = transport.request("blockchain.address.get_history", [
      addressA,
    ]);
    await delay(70);
    const [first, second] = fake.calls("blockchain.address.get_history");
    expect(second).toBeDefined();
    fake.respond(first.id, { result: ["first"] });

    expect(await request).toEqual(["first"]);
  });

  test("does not send a timed out broadcast again", async () => {
    const fake = new FakeServer();
    transport = new ElectrumTransport(asServer(fake), { requestTimeout: 50 });

    const request = transport.request("blockchain.transaction.broadcast", [
      "0200",
    ]);

    await expect(request).rejects.toBeInstanceOf(ElectrumTimeoutError);
    expect(fake.calls("blockchain.transaction.broadcast")).toHaveLength(1);
  });

  test("sends a request that lost its connection again on a new connection", async () => {
    const fake = new FakeServer();
    fake.handlers.set("blockchain.relayfee", (_params, call) => {
      if (call === 1) {
        setTimeout(() => fake.drop(), 0);
        return undefined;
      }
      return { result: 0.00001 };
    });
    transport = new ElectrumTransport(asServer(fake));

    const result = await transport.request("blockchain.relayfee");

    expect(result).toBe(0.00001);
    expect(fake.calls("blockchain.relayfee")).toHaveLength(2);
    expect(fake.connects).toBe(2);
  });
});

describe("ElectrumTransport subscriptions", () => {
  function serveStatuses(fake: FakeServer) {
    fake.handlers.set("blockchain.address.subscribe", ([address]) => ({
      result: `status of ${String(address)}`,
    }));
    fake.handlers.set("blockchain.address.unsubscribe", () => ({
      result: true,
    }));
    fake.handlers.set("blockchain.headers.subscribe", () => ({
      result: { height: 100, hex: "00" },
    }));
  }

  test("routes each notification to the subscription it is for", async () => {
    const fake = new FakeServer();
    serveStatuses(fake);
    transport = new ElectrumTransport(asServer(fake));
    const a: unknown[] = [];
    const b: unknown[] = [];
    const headers: unknown[] = [];

    await transport.subscribe("blockchain.address.subscribe", [addressA], (d) =>
      a.push(d),
    );
    await transport.subscribe("blockchain.address.subscribe", [addressB], (d) =>
      b.push(d),
    );
    await transport.subscribe("blockchain.headers.subscribe", [], (d) =>
      headers.push(d),
    );
    expect(a).toEqual([[addressA, `status of ${addressA}`]]);
    expect(b).toEqual([[addressB, `status of ${addressB}`]]);
    expect(headers).toEqual([[{ height: 100, hex: "00" }]]);

    fake.notify("blockchain.address.subscribe", [addressA, "new status"]);
    fake.notify("blockchain.headers.subscribe", [{ height: 101, hex: "01" }]);
    await vi.waitFor(() => expect(headers).toHaveLength(2));

    expect(a).toEqual([
      [addressA, `status of ${addressA}`],
      [addressA, "new status"],
    ]);
    expect(b).toHaveLength(1);
    expect(headers[1]).toEqual([{ height: 101, hex: "01" }]);
  });

  test("shares one server subscription between subscribers and ends it with the last", async () => {
    const fake = new FakeServer();
    serveStatuses(fake);
    transport = new ElectrumTransport(asServer(fake));
    const first: unknown[] = [];
    const second: unknown[] = [];

    const unsubscribeFirst = await transport.subscribe(
      "blockchain.address.subscribe",
      [addressA],
      (d) => first.push(d),
    );
    const unsubscribeSecond = await transport.subscribe(
      "blockchain.address.subscribe",
      [addressA],
      (d) => second.push(d),
    );

    expect(fake.calls("blockchain.address.subscribe")).toHaveLength(1);
    expect(second).toEqual([[addressA, `status of ${addressA}`]]);

    await unsubscribeFirst();
    fake.notify("blockchain.address.subscribe", [addressA, "new status"]);
    await vi.waitFor(() => expect(second).toHaveLength(2));
    expect(first).toHaveLength(1);
    expect(fake.calls("blockchain.address.unsubscribe")).toHaveLength(0);

    await unsubscribeSecond();
    await vi.waitFor(() =>
      expect(fake.calls("blockchain.address.unsubscribe")).toHaveLength(1),
    );
    expect(fake.calls("blockchain.address.unsubscribe")[0].params).toEqual([
      addressA,
    ]);
  });

  test("ends the server subscription after a joining listener threw on its replay", async () => {
    const fake = new FakeServer();
    serveStatuses(fake);
    transport = new ElectrumTransport(asServer(fake));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const unsubscribeFirst = await transport.subscribe(
      "blockchain.address.subscribe",
      [addressA],
      () => {},
    );
    const unsubscribeSecond = await transport.subscribe(
      "blockchain.address.subscribe",
      [addressA],
      () => {
        throw new Error("listener failed");
      },
    );
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();

    await unsubscribeFirst();
    await unsubscribeSecond();
    await vi.waitFor(() =>
      expect(fake.calls("blockchain.address.unsubscribe")).toHaveLength(1),
    );
  });

  test("keeps a subscription across a reconnect", async () => {
    const fake = new FakeServer();
    serveStatuses(fake);
    fake.handlers.set("blockchain.relayfee", () => ({ result: 0.00001 }));
    transport = new ElectrumTransport(asServer(fake));
    const received: unknown[] = [];

    await transport.subscribe("blockchain.address.subscribe", [addressA], (d) =>
      received.push(d),
    );
    fake.drop();
    fake.handlers.set("blockchain.address.subscribe", () => ({
      result: "status after reconnect",
    }));
    await transport.request("blockchain.relayfee");

    // electrum-cash restores the subscription on the new connection, and its status comes through
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[1]).toEqual([addressA, "status after reconnect"]);
    expect(fake.connects).toBe(2);
    expect(fake.calls("blockchain.address.subscribe")).toHaveLength(2);

    // a round trip lets anything still under way arrive, a duplicate restore included
    await transport.request("blockchain.relayfee");
    expect(received).toHaveLength(2);
  });

  test("delivers each notification once after close() and connect()", async () => {
    const fake = new FakeServer();
    serveStatuses(fake);
    fake.handlers.set("blockchain.relayfee", () => ({ result: 0.00001 }));
    transport = new ElectrumTransport(asServer(fake));
    const before: unknown[] = [];
    await transport.subscribe("blockchain.address.subscribe", [addressA], (d) =>
      before.push(d),
    );

    for (let cycle = 0; cycle < 3; cycle++) {
      await transport.close();
      await transport.connect();
    }
    const received: unknown[] = [];
    await transport.subscribe("blockchain.address.subscribe", [addressA], (d) =>
      received.push(d),
    );
    fake.notify("blockchain.address.subscribe", [addressA, "new status"]);
    await transport.request("blockchain.relayfee");

    expect(received).toEqual([
      [addressA, `status of ${addressA}`],
      [addressA, "new status"],
    ]);
    // close() ended the subscription made before it
    expect(before).toHaveLength(1);
  });
});

describe("ElectrumTransport connecting", () => {
  test("rejects a server that does not connect in time with an ElectrumTimeoutError", async () => {
    const fake = new FakeServer();
    fake.hangOnConnect = true;
    transport = new ElectrumTransport(asServer(fake), { connectTimeout: 50 });

    await expect(transport.connect()).rejects.toThrow(
      "Connecting to 'fake.example' timed out after 50 ms",
    );
    await expect(transport.request("blockchain.relayfee")).rejects.toThrow(
      Error,
    );
  });

  test("tries the servers in order and stays with the first that connects", async () => {
    const down = new FakeServer("down.example");
    down.hangOnConnect = true;
    const up = new FakeServer("up.example");
    const later = new FakeServer("later.example");
    up.handlers.set("blockchain.relayfee", () => ({ result: 0.00001 }));
    transport = new ElectrumTransport(
      [asServer(down), asServer(up), asServer(later)],
      { connectTimeout: 50 },
    );

    expect(await transport.request("blockchain.relayfee")).toBe(0.00001);
    expect(later.connects).toBe(0);
  });

  test("gives up a reconnect within the connect timeout, so that close() does not wait for it", async () => {
    transport = new ElectrumTransport("wss://fake.example:50004", {
      connectTimeout: 50,
      requestTimeout: 4000,
    });
    const fake = lastUrlSocket();
    await transport.connect();
    fake.drop();
    fake.hangOnConnect = true;

    await expect(transport.request("blockchain.relayfee")).rejects.toThrow(
      "Connecting to 'fake.example' timed out after 50 ms",
    );
    const closing = Date.now();
    await transport.close();
    expect(Date.now() - closing).toBeLessThan(1000);
  });

  test("replaces a connection that went silent before sending a request again", async () => {
    transport = new ElectrumTransport("wss://fake.example:50004", {
      requestTimeout: 400,
    });
    const fake = lastUrlSocket();
    fake.handlers.set("blockchain.relayfee", () => ({ result: 0.00001 }));
    await transport.connect();
    // electrum-cash only counts a send as unanswered when it is later than the last data received,
    // in whole milliseconds
    await delay(5);
    fake.silent = true;

    expect(await transport.request("blockchain.relayfee")).toBe(0.00001);
    expect(fake.connects).toBe(2);
    expect(fake.calls("blockchain.relayfee")).toHaveLength(1);
  });

  test("accepts only plain ws:// and wss:// URLs", () => {
    expect(
      () => new ElectrumTransport("wss://fulcrum.example:50004"),
    ).not.toThrow();
    expect(() => new ElectrumTransport("ws://127.0.0.1:60003")).not.toThrow();
    expect(() => new ElectrumTransport("tcp://fulcrum.example:50001")).toThrow(
      "only wss:// and ws://",
    );
    // rpckit's notation from mainnet-js 4.0.0-next
    expect(
      () => new ElectrumTransport("wss://fulcrum.example:50004?timeout=5000"),
    ).toThrow("only a host and port");
    expect(
      () =>
        new ElectrumTransport(
          "fallback(wss://a.example:50004,wss://b.example:50004)",
        ),
    ).toThrow();
    expect(() => new ElectrumTransport([])).toThrow(
      "At least one electrum server",
    );
  });
});

describe("a broadcast through the provider", () => {
  const txHex = "0200";

  function provider(fake: FakeServer, options = {}) {
    transport = new ElectrumTransport(asServer(fake), options);
    fake.handlers.set("blockchain.transaction.subscribe", () => ({
      result: null,
    }));
    return new ElectrumNetworkProvider(transport);
  }

  test("a refusal is a BroadcastRejectedError with the node's reason", async () => {
    const fake = new FakeServer();
    const message =
      "the transaction was rejected by network rules.\n\ntxn-mempool-conflict (code 18)\n";
    fake.handlers.set("blockchain.transaction.broadcast", () => ({
      error: { code: 1, message },
    }));

    const error = await provider(fake)
      .sendRawTransaction(txHex)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BroadcastRejectedError);
    const rejected = error as BroadcastRejectedError;
    expect(rejected.name).toBe("BroadcastRejectedError");
    expect(rejected.message).toBe(message);
    expect(rejected.reason).toBe("txn-mempool-conflict");
    expect(rejected.code).toBe(18);
    expect(rejected.txid).toBe(await getTransactionHash(txHex));
    expect(rejected.cause).toBeInstanceOf(Error);
    expect((rejected.cause as Error).cause).toEqual({ code: 1, message });
    expect(rejected.alreadyKnown).toBe(false);
  });

  test.each([
    "txn-already-known (code 18)",
    "txn-already-in-mempool (code 18)",
    "transaction already in block chain",
  ])(
    "an answer that the node holds the transaction, %s, is alreadyKnown",
    async (answer) => {
      const fake = new FakeServer();
      const message = `the transaction was rejected by network rules.\n\n${answer}\n`;
      fake.handlers.set("blockchain.transaction.broadcast", () => ({
        error: { code: 1, message },
      }));

      const error = await provider(fake)
        .sendRawTransaction(txHex)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BroadcastRejectedError);
      expect((error as BroadcastRejectedError).alreadyKnown).toBe(true);
    },
  );

  test("a timed out broadcast stays an ElectrumTimeoutError", async () => {
    const fake = new FakeServer();
    const error = await provider(fake, { requestTimeout: 50 })
      .sendRawTransaction(txHex)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ElectrumTimeoutError);
    expect(error).not.toBeInstanceOf(BroadcastRejectedError);
  });

  test("a broadcast that loses its connection is not a refusal", async () => {
    const fake = new FakeServer();
    fake.handlers.set("blockchain.transaction.broadcast", () => {
      setTimeout(() => fake.drop(), 0);
      return undefined;
    });
    const error = await provider(fake)
      .sendRawTransaction(txHex)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BroadcastRejectedError);
  });
});
