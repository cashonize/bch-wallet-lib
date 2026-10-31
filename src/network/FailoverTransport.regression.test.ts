import { FakeServer } from "#test/fakeElectrumServer.js";
import { delay } from "../util/delay.js";
import type { HexHeaderI } from "../interface.js";
import { ElectrumTransport } from "./ElectrumTransport.js";
import { ElectrumConnectError } from "./errors.js";
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
    // a connect attempt still under way when a revives gives up after its timeout, so a request
    // can fail once before one gets through
    revive(a);
    await vi.waitFor(() => transport.request("blockchain.relayfee"));

    const subscribedOnA = () =>
      a.sockets.flatMap((s) =>
        s.calls("blockchain.address.subscribe").map((call) => call.params[0]),
      );
    await vi.waitFor(() => expect(subscribedOnA()).toContain(address2));
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
      await vi.waitFor(() => single.request("blockchain.relayfee"));
      expect(changes).toEqual([false, true]);
    } finally {
      await single.close();
    }
  });
});

describe("concurrent settles on the server that stays", () => {
  test("a given-up switch whose server comes back delivers each notification once, and none after unsubscribe", async () => {
    const a = host("a.example");
    const b = host("b.example");
    let heldId: unknown;
    b.customize = (fake) => {
      fake.handlers.set("blockchain.address.subscribe", ([addr]) => {
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
    await vi.waitFor(() => expect(heldId).toBeDefined());
    const statuses: unknown[] = [];
    const unsubscribe = await transport.subscribe(
      "blockchain.address.subscribe",
      [address2],
      (data) => statuses.push(data),
    );

    // a is reachable again (electrum-cash's own retry is seconds away), b refuses: the switch is
    // given up and address2 is handed back to a
    revive(a);
    b.sockets[0].respond(heldId, { error: { code: 1, message: "refused" } });
    await vi.waitFor(() => expect(transport.server).toBe(a.url));
    await vi.waitFor(() =>
      expect(a.sockets.some((s) => s.connected)).toBe(true),
    );
    await delay(200);

    const live = a.sockets.find((s) => s.connected)!;
    statuses.length = 0;
    live.notify("blockchain.address.subscribe", [address2, "paid"]);
    await delay(50);
    expect.soft(statuses).toEqual([[address2, "paid"]]);

    await unsubscribe();
    statuses.length = 0;
    live.notify("blockchain.address.subscribe", [address2, "after"]);
    await delay(50);
    expect.soft(statuses).toEqual([]);
  });
});

describe("a tip that stops moving", () => {
  test(
    "leaves a server whose tip goes stale while it is in use and sends no new block",
    { timeout: 10_000 },
    async () => {
      const a = host("a.example");
      const b = host("b.example");
      transport = new FailoverTransport([a.url, b.url], {
        connectTimeout: 50,
        requestTimeout: 400,
        gracePeriod: 150,
        staleTipSeconds: 1,
      });
      // a wallet's watchBlocks: the tip is learned from the subscription only
      await transport.subscribe("blockchain.headers.subscribe", [], () => {});
      expect(transport.server).toBe(a.url);

      // a stops following the chain: no further header; b keeps up
      const refresh = setInterval(() => (b.tip = header(101)), 200);
      try {
        await vi.waitFor(() => expect(transport.server).toBe(b.url), {
          timeout: 5_000,
        });
      } finally {
        clearInterval(refresh);
      }
    },
  );
});

describe("unsubscribe during a switch", () => {
  test("an entry unsubscribed while the switch moves it is not left subscribed on the new server", async () => {
    const a = host("a.example");
    const b = host("b.example");
    let heldId: unknown;
    b.customize = (fake) => {
      fake.handlers.set("blockchain.address.subscribe", ([addr]) => {
        heldId = fake.calls("blockchain.address.subscribe").at(-1)!.id;
        return addr === address ? undefined : { result: "x" };
      });
    };
    transport = new FailoverTransport([a.url, b.url], {
      connectTimeout: 50,
      requestTimeout: 2000,
      gracePeriod: 150,
    });
    const statuses: unknown[] = [];
    const unsubscribe = await transport.subscribe(
      "blockchain.address.subscribe",
      [address],
      (data) => statuses.push(data),
    );
    kill(a);
    await vi.waitFor(() => expect(heldId).toBeDefined());
    await unsubscribe();
    b.sockets[0].respond(heldId, { result: "late" });
    await vi.waitFor(() => expect(transport.server).toBe(b.url));
    await delay(50);
    statuses.length = 0;
    b.sockets[0].notify("blockchain.address.subscribe", [address, "paid"]);
    await delay(50);
    expect(statuses).toEqual([]);
  });
});

describe("FailoverTransport's onConnectionChange", () => {
  test("reports the server in use lost and back, and a switch as back", async () => {
    const a = host("a.example");
    const b = host("b.example");
    const changes: boolean[] = [];
    transport = new FailoverTransport([a.url, b.url], {
      connectTimeout: 50,
      requestTimeout: 400,
      gracePeriod: 150,
      onConnectionChange: (connected) => changes.push(connected),
    });
    await transport.request("blockchain.relayfee");
    expect(changes).toEqual([]);

    kill(a);
    await vi.waitFor(() => expect(changes).toEqual([false, true]));
    expect(transport.server).toBe(b.url);
  });

  test("works with one server too, which never switches", async () => {
    const a = host("a.example");
    const changes: boolean[] = [];
    transport = new FailoverTransport([a.url], {
      connectTimeout: 50,
      requestTimeout: 200,
      onConnectionChange: (connected) => changes.push(connected),
    });
    await transport.request("blockchain.relayfee");
    kill(a);
    await expect(transport.request("blockchain.relayfee")).rejects.toThrow();
    revive(a);
    await vi.waitFor(() => transport.request("blockchain.relayfee"));
    expect(changes).toEqual([false, true]);
  });
});

describe("starting", () => {
  test("a bad server URL throws when the transport is made, not as an unreachable server", () => {
    expect(
      () =>
        new FailoverTransport(["wss://a.example:50004", "https://b.example"]),
    ).toThrow(/only wss:\/\/ and ws:\/\//);
  });

  test("no server to start on is an ElectrumConnectError naming each server", async () => {
    const a = host("a.example");
    const b = host("b.example");
    a.down = true;
    b.down = true;
    transport = new FailoverTransport([a.url, b.url], {
      connectTimeout: 50,
      requestTimeout: 200,
    });
    const error = await transport.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElectrumConnectError);
    expect(
      (error as ElectrumConnectError).failures.map((f) => f.server),
    ).toEqual([a.url, b.url]);
  });
});

describe("a stale server", () => {
  test("is left at most once per check interval, not on every stale block", async () => {
    const a = host("a.example");
    const b = host("b.example");
    // b is stale too, so every try to leave a walks to b and gives up
    b.tip = header(100, now() - 3600);
    transport = new FailoverTransport([a.url, b.url], {
      connectTimeout: 50,
      requestTimeout: 400,
      gracePeriod: 2_000,
      staleTipSeconds: 1,
    });
    const notify = (height: number) =>
      a.sockets[0].notify("blockchain.headers.subscribe", [
        header(height, now() - 3600),
      ]);
    await transport.subscribe("blockchain.headers.subscribe", [], () => {});
    for (let height = 101; height <= 105; height++) {
      notify(height);
      await delay(50);
    }
    await delay(300);
    expect(b.sockets.length).toBe(1);
  });
});
