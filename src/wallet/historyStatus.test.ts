import { binToHex, sha256, utf8ToBin } from "@bitauth/libauth";
import { Network, TxI } from "../interface.js";
import { removeGlobalProvider, setGlobalProvider } from "../network/default.js";
import ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";
import { Transport } from "../network/Transport.js";
import { BaseWallet } from "./Base.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { RegTestWatchWallet } from "./Watch.js";

// The electrum status of a history: sha256 of `tx_hash:height:` over it, null when empty
const statusOf = (history: TxI[]) =>
  history.length
    ? binToHex(
        sha256.hash(
          utf8ToBin(
            history.map((tx) => `${tx.tx_hash}:${tx.height}:`).join(""),
          ),
        ),
      )
    : null;

/// Serves each address's history, announcing a change to it when told
class HistoryTransport implements Transport {
  histories = new Map<string, TxI[]>();
  // what the server announces, its own history's status unless set apart
  announced = new Map<string, string | null>();
  historyRequests: { address: string; fromHeight: number }[] = [];
  private listeners = new Map<string, (data: any) => void>();
  async connect() {}
  async close() {}
  async request(method: string, params: any[] = []) {
    const [address, fromHeight = 0] = params;
    const history = this.histories.get(address) ?? [];
    switch (method) {
      case "blockchain.address.listunspent":
        return [];
      case "blockchain.address.get_history":
        this.historyRequests.push({ address, fromHeight });
        return history.filter(
          (tx) => tx.height <= 0 || tx.height >= fromHeight,
        );
      default:
        throw new Error(`not served: ${method}`);
    }
  }
  async subscribe(method: string, params: any[], onData: (data: any) => void) {
    if (method !== "blockchain.address.subscribe") {
      throw new Error(`not served: ${method}`);
    }
    this.listeners.set(params[0], onData);
    onData([params[0], this.status(params[0])]);
    return async () => {};
  }
  set(address: string, history: TxI[]) {
    this.histories.set(address, history);
    this.listeners.get(address)?.([address, this.status(address)]);
  }
  private status(address: string) {
    if (this.announced.has(address)) return this.announced.get(address)!;
    return statusOf(this.histories.get(address) ?? []);
  }
}

const tx = (letter: string, height: number): TxI => ({
  tx_hash: letter.repeat(64),
  height,
});
const [A, B, D] = [tx("a", 100), tx("b", 105), tx("d", 110)];
const sorted = (history: TxI[]) =>
  [...history].sort((a, b) => a.tx_hash.localeCompare(b.tx_hash));

let transport: HistoryTransport;
let wallet: BaseWallet;
beforeEach(() => {
  transport = new HistoryTransport();
  setGlobalProvider(
    Network.REGTEST,
    new ElectrumNetworkProvider(transport, Network.REGTEST),
  );
});
afterEach(async () => {
  await wallet.stop();
  removeGlobalProvider(Network.REGTEST);
});

const wallets = {
  watch: async () => {
    const hd = await RegTestHDWallet.newRandom();
    await hd.stop();
    return new RegTestWatchWallet()["watchOnly"](hd.getDepositAddress());
  },
  hd: () => RegTestHDWallet.newRandom(),
};

describe.each(Object.entries(wallets))(
  "a %s wallet's history after a reorg below its last confirmed height",
  (_, make) => {
    let address: string;
    beforeEach(async () => {
      wallet = await make();
      address = wallet.getDepositAddress();
      await wallet.getBalance();
      transport.set(address, [A, B, D]);
      await vi.waitFor(async () =>
        expect(sorted(await wallet.getRawHistory())).toEqual([A, B, D]),
      );
      transport.historyRequests = [];
    });

    test("leaves out a transaction the reorg dropped", async () => {
      transport.set(address, [A, D]);
      await vi.waitFor(async () =>
        expect(sorted(await wallet.getRawHistory())).toEqual([A, D]),
      );
    });

    test("shows a transaction the reorg sent back to the mempool as unconfirmed", async () => {
      const unconfirmed = { ...B, height: 0 };
      transport.set(address, [A, D, unconfirmed]);
      await vi.waitFor(async () =>
        expect(sorted(await wallet.getRawHistory())).toEqual([
          A,
          unconfirmed,
          D,
        ]),
      );
    });

    test("fetches again on the next notification when the history never matched the status", async () => {
      transport.announced.set(address, "ff".repeat(32));
      transport.set(address, [A, D]);
      await vi.waitFor(() => expect(transport.historyRequests).toHaveLength(2));
      expect(sorted(await wallet.getRawHistory())).toEqual([A, D]);

      // the same status announced again, as on a resubscribe, is fetched again
      transport.set(address, [A, D]);
      await vi.waitFor(() => expect(transport.historyRequests).toHaveLength(4));
    });
  },
);

test("an HD address whose first history never matched its status is not handed out again", async () => {
  const hd = await RegTestHDWallet.newRandom();
  wallet = hd;
  const address = hd.getDepositAddress();
  await hd.getBalance();
  transport.announced.set(address, "ff".repeat(32));
  transport.set(address, [A]);
  await vi.waitFor(async () => expect(await hd.getRawHistory()).toEqual([A]));
  expect(hd.getDepositAddress()).not.toBe(address);
});
