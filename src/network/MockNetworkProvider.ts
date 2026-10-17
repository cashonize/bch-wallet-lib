import type { Indexer, IndexerConfig } from "@paryonusd/mem-cash";
import { asTransport, createIndexer } from "@paryonusd/mem-cash";
import { Network, Utxo } from "../interface.js";
import { setGlobalProvider } from "./default.js";
import ElectrumNetworkProvider from "./ElectrumNetworkProvider.js";

export interface MockNetworkProviderOptions {
  /** Indexer config passed to createIndexer. */
  indexerConfig?: Partial<IndexerConfig>;
}

// The `bch-wallet-lib/mock` entry: kept out of the main entry so that app bundles never reach
// @paryonusd/mem-cash, a dev dependency

/**
 * In-memory NetworkProvider backed by @paryonusd/mem-cash.
 *
 * Inherits all Electrum protocol handling from ElectrumNetworkProvider.
 * Only adds test helpers (addUtxo, mine, setBlockHeight, reset) and
 * overrides mine() to use test.mine instead of the regtest node's RPC.
 */
export class MockNetworkProvider extends ElectrumNetworkProvider {
  /** The backing Indexer instance (extends Node). */
  public mc: Indexer;
  private connPromise?: Promise<void>;
  constructor(options?: MockNetworkProviderOptions) {
    const mc = createIndexer({
      addressPrefix: "bchreg",
      ...options?.indexerConfig,
    });
    super(asTransport(mc), Network.REGTEST);
    this.mc = mc;
  }

  override async connect(): Promise<void> {
    if (!this.connPromise) {
      this.connPromise = this.doInit();
    }
    return this.connPromise;
  }

  private async doInit(): Promise<void> {
    // set_chain_tip creates headers for max(0, h-10)..h only (11 headers).
    // Fill headers for heights 0..189 so that UTXOs placed at lower heights
    // have matching block headers for verbose transaction lookups.
    for (let h = 0; h < 190; h++) {
      const hash = h.toString(16).padStart(64, "0");
      await this.mc.request("test.add_header", [hash, h, 1700000000 + h]);
    }
    await this.mc.request("test.set_chain_tip", [200, 1700000200]);
  }

  // --- Test helpers ---

  async addUtxo(address: string, utxo: Omit<Utxo, "address">): Promise<void> {
    await this.ready();
    await this.mc.request("test.add_utxo", [address, utxo]);
  }

  override async mine(cashaddr: string, blocks: number): Promise<string[]> {
    await this.ready();
    const result = (await this.mc.request("test.mine", [cashaddr, blocks])) as {
      height: number;
      coinbaseTxids: string[];
    };
    return result.coinbaseTxids;
  }

  async setBlockHeight(height: number): Promise<void> {
    await this.ready();
    await this.mc.request("test.set_chain_tip", [height, 1700000000]);
  }

  async reset(): Promise<void> {
    await this.ready();
    await this.mc.request("test.reset", []);
    await this.mc.request("test.set_chain_tip", [200, 1700000000]);
  }

  async seedAlice(): Promise<void> {
    const address = process.env.ADDRESS;
    if (!address) return;
    await this.ready();
    for (let i = 0; i < 110; i++) {
      await this.mc.request("test.add_utxo", [
        address,
        {
          vout: 0,
          satoshis: 5_000_000_000,
          height: i + 1,
        },
      ]);
    }
  }
}

export async function createMockProvider(): Promise<MockNetworkProvider> {
  let verifier: import("@paryonusd/mem-cash/validation").TxVerifier | undefined;
  try {
    const { createTxVerifier } = await import("@paryonusd/mem-cash/validation");
    verifier = createTxVerifier({ vmVersion: "BCH_2026_05" });
  } catch {}
  return new MockNetworkProvider({ indexerConfig: { verifier } });
}

/** A mock chain as the global regtest provider, funding the address in `process.env.ADDRESS`. */
export async function initMockProvider(): Promise<MockNetworkProvider> {
  const provider = await createMockProvider();
  await provider.ready();
  await provider.seedAlice();
  setGlobalProvider(Network.REGTEST, provider);
  return provider;
}
