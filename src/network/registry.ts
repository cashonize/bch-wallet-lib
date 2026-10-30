import { mainnetServers, regtestServers, testnetServers } from "./constant.js";

/**
 * A block a server must agree on to be taken as following the network's chain. A checkpoint
 * after the last split from another chain tells the two apart where the genesis cannot: chipnet
 * and testnet4 share one.
 */
export interface ChainCheck {
  /** The genesis block hash, as `server.features` reports it */
  genesisHash: string;
  /** A block hash at a height after the last split, in the usual (reversed) hex */
  checkpoint?: { height: number; hash: string };
}

export interface NetworkConfig {
  /** The name in wallet ids and cache keys, e.g. "scalenet"; no ":" */
  name: string;
  /** The cashaddr prefix of its addresses */
  addressPrefix: "bitcoincash" | "bchtest" | "bchreg";
  /** The version its WIFs and extended keys are encoded with */
  keyVersion: "mainnet" | "testnet";
  /** The database its named wallets are stored in, of its own */
  dbName: string;
  /** The servers used when none are configured (`DefaultProvider.servers`, `ELECTRUM_<NAME>`) */
  servers?: string[];
  /**
   * Checked of every server `createFailoverProvider` connects to, and only there: a provider from
   * `createProvider`, or the global one a wallet takes without a provider, is not checked
   */
  chain?: ChainCheck;
}

// The built-in networks; their names and database names are part of the stored format of
// mainnet-js 3.1.7 and never change. "testnet" is chipnet.
const builtIn: NetworkConfig[] = [
  {
    name: "mainnet",
    addressPrefix: "bitcoincash",
    keyVersion: "mainnet",
    dbName: "bitcoincash",
    servers: mainnetServers,
    chain: {
      genesisHash:
        "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
      // after the BSV (556767) and eCash (661648) splits
      checkpoint: {
        height: 700000,
        hash: "000000000000000003d908ba7463fd154902eda89ac015a2e2630f4130674e77",
      },
    },
  },
  {
    name: "testnet",
    addressPrefix: "bchtest",
    keyVersion: "testnet",
    dbName: "bchtest",
    servers: testnetServers,
    chain: {
      genesisHash:
        "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b",
      // after chipnet split from testnet4
      checkpoint: {
        height: 227000,
        hash: "000000000c70141bb62412c38a766c396fe717f52cff4474c57fafd7242ef3ed",
      },
    },
  },
  {
    name: "regtest",
    addressPrefix: "bchreg",
    keyVersion: "testnet",
    dbName: "bchreg",
    servers: regtestServers,
  },
];

const networks = new Map<string, NetworkConfig>(
  builtIn.map((config) => [config.name, Object.freeze({ ...config })]),
);

// The library's own cache databases (see IndexedDbCache), which a wallet database would break
const cacheDbNames = ["WalletCache", "ElectrumNetworkProviderCache"];

/**
 * Adds a network an app uses beyond mainnet, chipnet ("testnet") and regtest, such as testnet4 or
 * scalenet. Register it before any wallet of it is loaded, and before `pruneWalletCaches`, which
 * drops the cache records of wallets on networks it does not know.
 *
 * @throws {Error} if the name or the database name is taken or empty, or the name holds a ":"
 */
export function registerNetwork(config: NetworkConfig): void {
  if (!config.name || config.name.includes(":")) {
    throw new Error(`Not a network name: '${config.name}'`);
  }
  if (!config.dbName || cacheDbNames.includes(config.dbName)) {
    throw new Error(`Not a wallet database name: '${config.dbName}'`);
  }
  if (networks.has(config.name)) {
    throw new Error(`The network ${config.name} is already registered`);
  }
  for (const other of networks.values()) {
    if (other.dbName === config.dbName) {
      throw new Error(
        `The database ${config.dbName} is the ${other.name} network's`,
      );
    }
  }
  let chain = config.chain;
  // servers report hashes in lowercase hex
  if (chain) {
    chain = { genesisHash: chain.genesisHash.toLowerCase() };
    if (config.chain?.checkpoint) {
      const { height, hash } = config.chain.checkpoint;
      chain.checkpoint = { height, hash: hash.toLowerCase() };
    }
  }
  networks.set(config.name, Object.freeze({ ...config, chain }));
}

/** Whether a network of that name is built in or registered */
export function isKnownNetwork(name: string | undefined): boolean {
  return name !== undefined && networks.has(name);
}

/**
 * The configuration of a built-in or registered network
 *
 * @throws {Error} for a network that is neither
 */
export function networkConfig(name: string): NetworkConfig {
  const config = networks.get(name);
  if (!config) throw new Error(`Unknown network '${name}'`);
  return config;
}

/** Every built-in and registered network, the built-in ones first */
export function knownNetworks(): NetworkConfig[] {
  return [...networks.values()];
}

/** @internal Tests only: drops the registered networks, keeping the built-in ones */
export function _resetRegisteredNetworks(): void {
  for (const name of networks.keys()) {
    if (!builtIn.some((config) => config.name === name)) networks.delete(name);
  }
}
