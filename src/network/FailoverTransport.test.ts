import { FakeServer } from "#test/fakeElectrumServer.js";
import { delay } from "../util/delay.js";
import type { HexHeaderI } from "../interface.js";
import ElectrumNetworkProvider from "./ElectrumNetworkProvider.js";
import { FailoverTransport } from "./FailoverTransport.js";

// Each server given by URL gets a new FakeServer per connection attempt, scripted by its Host
const sockets = vi.hoisted(() => ({
  create: (_host: string): unknown => undefined,
}));
vi.mock("@electrum-cash/web-socket", () => ({
  ElectrumWebSocket: function (host: string, options: object) {
    const socket = sockets.create(host) as { options: object };
    socket.options = options;
    return socket;
  },
}));

interface Host {
  url: string;
  down: boolean;
  tip: HexHeaderI;
  sockets: FakeServer[];
}

const hosts = new Map<string, Host>();
sockets.create = (name) => {
  const host = hosts.get(name)!;
  const fake = new FakeServer(name);
  fake.hangOnConnect = host.down;
  fake.handlers.set("blockchain.headers.get_tip", () => ({ result: host.tip }));
  fake.handlers.set("blockchain.headers.subscribe", () => ({
    result: host.tip,
  }));
  fake.handlers.set("blockchain.address.subscribe", ([address]) => ({
    result: `${name} status of ${String(address)}`,
  }));
  fake.handlers.set("blockchain.address.unsubscribe", () => ({ result: true }));
  fake.handlers.set("blockchain.relayfee", () => ({ result: 0.00001 }));
  host.sockets.push(fake);
  return fake;
};

const now = () => Math.floor(Date.now() / 1000);

// An 80-byte header whose only meaningful field is the timestamp
function header(height: number, timestamp = now()): HexHeaderI {
  const bytes = new Uint8Array(80);
  new DataView(bytes.buffer).setUint32(68, timestamp, true);
  return { height, hex: Buffer.from(bytes).toString("hex") };
}

function host(name: string, height = 100): Host {
  const entry = {
    url: `wss://${name}:50004`,
    down: false,
    tip: header(height),
    sockets: [],
  };
  hosts.set(name, entry);
  return entry;
}

// The server stops answering: the open connection drops and reconnects fail
function kill(entry: Host) {
  entry.down = true;
  for (const socket of entry.sockets) {
    socket.hangOnConnect = true;
    if (socket.connected) socket.drop();
  }
}

const contacted = (entry: Host) =>
  entry.sockets.some((socket) => socket.connects > 0);
const subscribed = (entry: Host) =>
  entry.sockets.some(
    (socket) => socket.calls("blockchain.address.subscribe").length > 0,
  );

const address = "bitcoincash:qrfdnsxr2lljh0ej2w6dvqx9mgdmasnlpgk99t8ch4";
const fast = { connectTimeout: 50, requestTimeout: 400, gracePeriod: 150 };

let transport: FailoverTransport;

afterEach(async () => {
  await transport?.close();
  hosts.clear();
});

describe("FailoverTransport at startup", () => {
  test("takes the next server when the first is unreachable", async () => {
    const a = host("a.example");
    const b = host("b.example");
    const c = host("c.example");
    a.down = true;
    const changes: string[] = [];
    transport = new FailoverTransport([a.url, b.url, c.url], {
      ...fast,
      onServerChange: (server) => changes.push(server),
    });

    expect(await transport.request("blockchain.relayfee")).toBe(0.00001);
    expect(transport.server).toBe(b.url);
    expect(changes).toEqual([b.url]);
    expect(contacted(c)).toBe(false);
  });

  test("does not walk on while the device is offline", async () => {
    const a = host("a.example");
    const b = host("b.example");
    a.down = true;
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      isOnline: () => false,
    });

    await expect(transport.connect()).rejects.toThrow("the device is offline");
    expect(contacted(b)).toBe(false);
  });

  test("passes over a server on a stale tip, and takes it when every server is stale", async () => {
    const a = host("a.example");
    const b = host("b.example");
    a.tip = header(100, now() - 5 * 3600);
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      staleTipSeconds: 3 * 3600,
    });
    await transport.connect();
    expect(transport.server).toBe(b.url);
    await transport.close();

    b.tip = header(100, now() - 5 * 3600);
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      staleTipSeconds: 3 * 3600,
    });
    await transport.connect();
    expect(transport.server).toBe(a.url);
  });
});

describe("FailoverTransport with one server", () => {
  test("never contacts another server, also after losing its own", async () => {
    const a = host("a.example");
    const other = host("other.example");
    transport = new FailoverTransport([a.url], {
      ...fast,
      staleTipSeconds: 3 * 3600,
    });
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    kill(a);
    a.sockets[0].notify("blockchain.headers.subscribe", [
      header(101, now() - 5 * 3600),
    ]);

    await delay(fast.gracePeriod * 3);
    expect(transport.server).toBe(a.url);
    expect(contacted(other)).toBe(false);
  });
});

describe("FailoverTransport after losing its server", () => {
  test("stays when the connection is back within the grace period", async () => {
    const a = host("a.example");
    const b = host("b.example");
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      gracePeriod: 300,
    });
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    a.sockets[0].drop();
    // a request reconnects at once, where electrum-cash would wait 5 s
    await transport.request("blockchain.relayfee");

    await delay(500);
    expect(transport.server).toBe(a.url);
    expect(contacted(b)).toBe(false);
  });

  test("moves every subscription to the next server after the grace period", async () => {
    const a = host("a.example");
    const b = host("b.example");
    const changes: string[] = [];
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      onServerChange: (server) => changes.push(server),
    });
    const statuses: unknown[] = [];
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      (data) => statuses.push(data),
    );
    kill(a);

    await vi.waitFor(() => expect(transport.server).toBe(b.url));
    expect(changes).toEqual([a.url, b.url]);
    expect(statuses.at(-1)).toEqual([
      address,
      `b.example status of ${address}`,
    ]);
    expect(await transport.request("blockchain.relayfee")).toBe(0.00001);

    b.sockets[0].notify("blockchain.address.subscribe", [address, "new"]);
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual([address, "new"]));
  });

  test("never switches while the device is offline, and does once it is back", async () => {
    const a = host("a.example");
    const b = host("b.example");
    let online = false;
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      isOnline: () => online,
    });
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    kill(a);

    await delay(fast.gracePeriod * 3);
    expect(contacted(b)).toBe(false);

    online = true;
    await vi.waitFor(() => expect(transport.server).toBe(b.url));
  });

  test("skips a server behind the tip seen, before subscribing anything there", async () => {
    const a = host("a.example", 100);
    const behind = host("behind.example", 98);
    const c = host("c.example", 99);
    transport = new FailoverTransport([a.url, behind.url, c.url], fast);
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    await transport.subscribe("blockchain.headers.subscribe", [], () => {});
    kill(a);

    await vi.waitFor(() => expect(transport.server).toBe(c.url));
    expect(contacted(behind)).toBe(true);
    expect(subscribed(behind)).toBe(false);
    expect(subscribed(c)).toBe(true);
  });

  test("stays on its server when no other one can be taken", async () => {
    const a = host("a.example");
    const b = host("b.example");
    b.down = true;
    transport = new FailoverTransport([a.url, b.url], fast);
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    kill(a);

    await delay(fast.gracePeriod * 3);
    expect(transport.server).toBe(a.url);
  });
});

describe("FailoverTransport on a stale tip", () => {
  test("leaves a server whose new tip is stale for one that is current", async () => {
    const a = host("a.example");
    const b = host("b.example");
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      staleTipSeconds: 3 * 3600,
    });
    await transport.subscribe("blockchain.headers.subscribe", [], () => {});
    a.sockets[0].notify("blockchain.headers.subscribe", [
      header(100, now() - 5 * 3600),
    ]);

    await vi.waitFor(() => expect(transport.server).toBe(b.url));
  });
});

describe("FailoverTransport requests", () => {
  test("a server's error response does not fail over", async () => {
    const a = host("a.example");
    const b = host("b.example");
    transport = new FailoverTransport([a.url, b.url], fast);
    await transport.connect();
    a.sockets[0].handlers.set("blockchain.transaction.get", () => ({
      error: { code: 2, message: "No such mempool or blockchain transaction" },
    }));

    await expect(
      transport.request("blockchain.transaction.get", ["00"]),
    ).rejects.toThrow("No such mempool");
    await delay(fast.gracePeriod * 2);
    expect(contacted(b)).toBe(false);
  });

  test("a broadcast lost to a switch is not sent to the new server, another request is", async () => {
    const a = host("a.example");
    const b = host("b.example");
    transport = new FailoverTransport([a.url, b.url], {
      ...fast,
      staleTipSeconds: 3 * 3600,
    });
    const provider = new ElectrumNetworkProvider(transport);
    await transport.subscribe("blockchain.headers.subscribe", [], () => {});
    // a takes both requests and answers neither, until the switch closes it
    a.sockets[0].handlers.delete("blockchain.relayfee");
    const broadcast = transport.request("blockchain.transaction.broadcast", [
      "00",
    ]);
    broadcast.catch(() => {});
    const fee = provider.getRelayFee();
    await vi.waitFor(() =>
      expect(a.sockets[0].calls("blockchain.relayfee")).toHaveLength(1),
    );
    a.sockets[0].notify("blockchain.headers.subscribe", [
      header(100, now() - 5 * 3600),
    ]);

    await expect(broadcast).rejects.toThrow();
    expect(await fee).toBe(0.00001);
    expect(transport.server).toBe(b.url);
    expect(
      b.sockets.flatMap((s) => s.calls("blockchain.transaction.broadcast")),
    ).toHaveLength(0);
  });
});
