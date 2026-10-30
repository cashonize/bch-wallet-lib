import { FakeServer } from "#test/fakeElectrumServer.js";
import { delay } from "../util/delay.js";
import type { HexHeaderI } from "../interface.js";
import { ElectrumTransport } from "./ElectrumTransport.js";
import { FailoverTransport } from "./FailoverTransport.js";

// Same harness as FailoverTransport.test.ts: each server given by URL gets a new FakeServer per
// transport, scripted by its Host
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
  customize?: (fake: FakeServer) => void;
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
  host.customize?.(fake);
  host.sockets.push(fake);
  return fake;
};

const now = () => Math.floor(Date.now() / 1000);

function header(height: number, timestamp = now()): HexHeaderI {
  const bytes = new Uint8Array(80);
  new DataView(bytes.buffer).setUint32(68, timestamp, true);
  return { height, hex: Buffer.from(bytes).toString("hex") };
}

function host(name: string, height = 100): Host {
  const entry: Host = {
    url: `wss://${name}:50004`,
    down: false,
    tip: header(height),
    sockets: [],
  };
  hosts.set(name, entry);
  return entry;
}

function kill(entry: Host) {
  entry.down = true;
  for (const socket of entry.sockets) {
    socket.hangOnConnect = true;
    if (socket.connected) socket.drop();
  }
}

function revive(entry: Host) {
  entry.down = false;
  for (const socket of entry.sockets) socket.hangOnConnect = false;
}

const contacted = (entry: Host) =>
  entry.sockets.some((socket) => socket.connects > 0);
const openConnections = (entry: Host) =>
  entry.sockets.filter((socket) => socket.connected).length;

const address = "bitcoincash:qrfdnsxr2lljh0ej2w6dvqx9mgdmasnlpgk99t8ch4";
const address2 = "bitcoincash:qz2g9hg86tpdk0rhk9qg45s6nj3xqqerkvcmz5rrq0";

let transport: FailoverTransport;

afterEach(async () => {
  await transport?.close();
  hosts.clear();
});

describe("close() while the transport walks the list", () => {
  test("close() during a switch's probe contacts no further server and leaves no connection open", async () => {
    const a = host("a.example");
    const b = host("b.example");
    const c = host("c.example");
    b.down = true; // b's connect hangs until the connect timeout
    transport = new FailoverTransport([a.url, b.url, c.url], {
      connectTimeout: 300,
      requestTimeout: 2000,
      gracePeriod: 100,
    });
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    kill(a);
    // the switch is now probing b
    await vi.waitFor(() => expect(contacted(b)).toBe(true));
    await transport.close();

    await delay(800);
    expect.soft(contacted(c)).toBe(false);
    expect.soft(openConnections(c)).toBe(0);
  });

  test("close() during startup contacts no further server and leaves no connection open", async () => {
    const a = host("a.example");
    const b = host("b.example");
    a.down = true;
    transport = new FailoverTransport([a.url, b.url], {
      connectTimeout: 300,
      requestTimeout: 2000,
    });
    transport.connect().catch(() => {});
    await vi.waitFor(() => expect(contacted(a)).toBe(true));
    await transport.close();

    await delay(800);
    expect.soft(contacted(b)).toBe(false);
    expect.soft(openConnections(b)).toBe(0);
  });
});

describe("offline/online flapping", () => {
  test(
    "a device back online whose server is reachable again does not move to another server",
    { timeout: 30_000 },
    async () => {
      const a = host("a.example");
      const b = host("b.example");
      let online = true;
      // default grace period: electrum-cash's 5 s reconnect delay plus the connect timeout
      transport = new FailoverTransport([a.url, b.url], {
        connectTimeout: 2000,
        requestTimeout: 4000,
        isOnline: () => online,
      });
      await transport.subscribe(
        "blockchain.address.subscribe",
        [address],
        () => {},
      );
      const socket = a.sockets[0];
      // the device goes offline: a connect fails at once (no DNS, no route), as offline sockets do
      online = false;
      a.down = true;
      socket.connect = async function (this: FakeServer) {
        this.connects++;
        if (a.down) {
          this.emit("disconnected");
          throw new Error("getaddrinfo ENOTFOUND");
        }
        this.connected = true;
        this.emit("connected");
      };
      socket.drop();

      // electrum-cash retries at ~5 s and ~10 s; both fail while offline
      await vi.waitFor(
        () => expect(socket.connects).toBeGreaterThanOrEqual(3),
        {
          timeout: 12_000,
          interval: 20,
        },
      );
      // the network is back, and so is a
      online = true;
      a.down = false;

      // electrum-cash's next retry (~15 s) reconnects a; nothing should have switched meanwhile
      await vi.waitFor(() => expect(transport.server).toBeDefined());
      await delay(6_000);
      expect.soft(contacted(b)).toBe(false);
      expect(transport.server).toBe(a.url);
    },
  );
});

describe("a switch that is given up", () => {
  test("a subscription made on the candidate during a failed switch reaches the server that stays", async () => {
    const a = host("a.example");
    const b = host("b.example");
    let heldId: unknown;
    b.customize = (fake) => {
      fake.handlers.set("blockchain.address.subscribe", ([addr], _call) => {
        if (addr === address) {
          heldId = fake.calls("blockchain.address.subscribe").at(-1)!.id;
          return undefined;
        }
        return { result: `b status of ${String(addr)}` };
      });
    };
    transport = new FailoverTransport([a.url, b.url], {
      connectTimeout: 50,
      requestTimeout: 400,
      gracePeriod: 150,
    });
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    kill(a);

    // the switch to b is moving the first subscription, and b is the server in use meanwhile
    await vi.waitFor(() => expect(heldId).toBeDefined());
    expect(transport.server).toBe(b.url);
    const statuses: unknown[] = [];
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address2],
      (data) => statuses.push(data),
    );

    // b refuses the first subscription, so the switch is given up and a stays the server in use
    b.down = true;
    b.sockets[0].respond(heldId, {
      error: { code: 1, message: "refused" },
    });
    await vi.waitFor(() => expect(transport.server).toBe(a.url));
    await delay(100);

    // a comes back (a request reconnects it at once)
    revive(a);
    await transport.request("blockchain.relayfee");
    await delay(100);

    const subscribedOnA = a.sockets.flatMap((s) =>
      s.calls("blockchain.address.subscribe").map((call) => call.params[0]),
    );
    expect(subscribedOnA).toContain(address2);
    a.sockets[0].notify("blockchain.address.subscribe", [address2, "paid"]);
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual([address2, "paid"]));
  });
});

describe("a candidate that refuses a subscription", () => {
  test("ends the switch, so no third server sees the subscriptions before the next grace period", async () => {
    const a = host("a.example");
    const b = host("b.example");
    const c = host("c.example");
    b.customize = (fake) => {
      fake.handlers.set("blockchain.address.subscribe", () => ({
        error: { code: 1, message: "refused" },
      }));
    };
    transport = new FailoverTransport([a.url, b.url, c.url], {
      connectTimeout: 50,
      requestTimeout: 400,
      gracePeriod: 300,
    });
    await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      () => {},
    );
    kill(a);

    await vi.waitFor(() =>
      expect(
        b.sockets.some(
          (s) => s.calls("blockchain.address.subscribe").length > 0,
        ),
      ).toBe(true),
    );
    await delay(150);
    expect(contacted(c)).toBe(false);

    // the next grace period walks again: b refuses again and ends that walk too, so c only
    // becomes the server in use once b is out of the way
    kill(b);
    await vi.waitFor(() => expect(transport.server).toBe(c.url), {
      timeout: 3000,
    });
  });
});

describe("ElectrumTransport's onConnectionChange", () => {
  test("is told once per loss, also when requests fail to connect while the server is down", async () => {
    const a = host("a.example");
    const changes: boolean[] = [];
    const single = new ElectrumTransport(a.url, {
      connectTimeout: 50,
      requestTimeout: 200,
      onConnectionChange: (connected) => changes.push(connected),
    });
    try {
      await single.request("blockchain.relayfee");
      kill(a);
      await expect(single.request("blockchain.relayfee")).rejects.toThrow();
      await expect(single.request("blockchain.relayfee")).rejects.toThrow();
      expect(changes).toEqual([false]);

      revive(a);
      await single.request("blockchain.relayfee");
      expect(changes).toEqual([false, true]);
    } finally {
      await single.close();
    }
  });
});
