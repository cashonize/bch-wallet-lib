import { walletCacheIdFromWalletId } from "../cache/walletCache.js";
import { default as IndexedDBProvider } from "../indexeddb/IndexedDBProvider.js";
import {
  BaseWallet,
  HDWallet,
  DefaultProvider,
  InvalidWalletIdError,
  namedWalletExists,
  networkConfig,
  registerNetwork,
  saveNamedWallet,
  Wallet,
} from "../index.js";
import { RegTestWallet } from "../wallet/Wif.js";
import { getDefaultServers } from "./configuration.js";
import {
  getGlobalProvider,
  removeGlobalProvider,
  setGlobalProvider,
} from "./default.js";
import { getTransactionHash } from "../util/transaction.js";
import ElectrumNetworkProvider from "./ElectrumNetworkProvider.js";
import { MockNetworkProvider } from "./MockNetworkProvider.js";
import { _resetRegisteredNetworks, type NetworkConfig } from "./registry.js";

// Testnet4 as an app would register it: it shares chipnet's address prefix, key version and
// genesis, so only its name, database and checkpoint tell the two apart
const testnet4: NetworkConfig = {
  name: "testnet4",
  addressPrefix: "bchtest",
  keyVersion: "testnet",
  dbName: "bchtest4",
  servers: ["wss://testnet4.imaginary.cash:50004"],
  chain: {
    genesisHash:
      "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b",
    checkpoint: {
      height: 227000,
      hash: "0000000028741efb2fdaf5be975e4c313a90e3d44f7b855c224cea95583ca26b",
    },
  },
};
const options = { network: "testnet4" };
const address = "qppr9h7whx9pzucgqukhtlj8lvgvjlgr3g9ggtkq22";
const testnetWif = "cPS12C2bpGHtKjS5NXNyWyTGGRMPk7D7pjp5JfgxRKWyFnWoDyZg";
const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

beforeEach(() => {
  registerNetwork(testnet4);
});
afterEach(() => {
  _resetRegisteredNetworks();
  DefaultProvider.servers.testnet4 = "";
  delete process.env.ELECTRUM_TESTNET4;
});

test("refuses a taken name or database, and a name with a colon", () => {
  expect(() => registerNetwork(testnet4)).toThrow("already registered");
  expect(() =>
    registerNetwork({ ...testnet4, name: "scalenet", dbName: "bchtest" }),
  ).toThrow("is the testnet network's");
  expect(() =>
    registerNetwork({ ...testnet4, name: "testnet", dbName: "other" }),
  ).toThrow("already registered");
  expect(() =>
    registerNetwork({ ...testnet4, name: "a:b", dbName: "other" }),
  ).toThrow("Not a network name");
  expect(() =>
    registerNetwork({ ...testnet4, name: "scalenet", dbName: "WalletCache" }),
  ).toThrow("Not a wallet database name");
  expect(() =>
    registerNetwork({ ...testnet4, name: "scalenet", dbName: "" }),
  ).toThrow("Not a wallet database name");
  expect(networkConfig("testnet").dbName).toBe("bchtest");
});

test("keeps the chain hashes in the lowercase servers report", () => {
  _resetRegisteredNetworks();
  registerNetwork({
    ...testnet4,
    chain: {
      genesisHash: testnet4.chain!.genesisHash.toUpperCase(),
      checkpoint: { height: 227000, hash: "ABCD" },
    },
  });
  expect(networkConfig("testnet4").chain).toEqual({
    genesisHash: testnet4.chain!.genesisHash,
    checkpoint: { height: 227000, hash: "abcd" },
  });
});

// Headers as the public servers serve them at the built-in checkpoints, so a wrong hash in the
// registry, which would refuse every server, fails here
test("the built-in checkpoints are the hashes of those blocks", async () => {
  const headers: Record<string, string> = {
    mainnet:
      "002000202c59ce4f2b8b307624e76e10c7aebd09963a2680b2ebf1030000000000000000fa725fff16fcb89a6c4e204e9a0cacb7c2a57d05b2426558b0002c3e5ee9af1979271161ae060618cbc1b42e",
    testnet:
      "00000020e0f3e817a6e85ae3e527c90c78ab42ef3381c77e28dc515975c2de4c000000003761c8e0f5557ba9271777734629540cc34f2a6537160c713155c6b0274c457b6e373567ea28551c0cd40d2e",
    testnet4:
      "00000020dd4d488b15505869869b92f040ecacbdd63354f0dbc0d4d123247501000000003add46d53f982a57269eb3028046235a27adce112b26f9142d123f98a8df0e05c1233567977e281ca18dda27",
  };
  for (const [network, header] of Object.entries(headers)) {
    expect(await getTransactionHash(header)).toBe(
      networkConfig(network).chain!.checkpoint!.hash,
    );
  }
});

test("a registered network's id loads with the network option only", async () => {
  const wallet = await Wallet.fromId(`watch:testnet4:${address}`, options);
  expect(wallet.network).toBe("testnet4");
  expect(wallet.cashaddr).toBe(`bchtest:${address}`);
  expect(wallet.toDbString()).toBe(`watch:testnet4:bchtest:${address}`);

  await expect(
    Wallet.fromId(`watch:testnet4:${address}`),
  ).rejects.toBeInstanceOf(InvalidWalletIdError);
  await expect(
    Wallet.fromId(`watch:testnet:${address}`, options),
  ).rejects.toBeInstanceOf(InvalidWalletIdError);
  await expect(
    Wallet.fromId(
      "watch:testnet4:bitcoincash:qrvcdmgpk73zyfd8pmdl9wnuld36zh9n4gms8s0u59",
      options,
    ),
  ).rejects.toThrow("cannot be watched");
  await expect(
    RegTestWallet.fromId(`watch:testnet4:${address}`, options),
  ).rejects.toThrow("a regtest wallet class cannot make a testnet4 wallet");
  await expect(
    Wallet.fromId(`watch:scalenet:${address}`, { network: "scalenet" }),
  ).rejects.toThrow("Unknown network 'scalenet'");
});

test("an HD wallet of a registered network uses its key version and prefix", async () => {
  const provider = new MockNetworkProvider({
    network: "testnet4",
    indexerConfig: { addressPrefix: "bchtest" },
  });
  await provider.connect();
  const wallet = await HDWallet.fromId(`hd:testnet4:${mnemonic}`, {
    ...options,
    provider,
  });
  try {
    expect(wallet.network).toBe("testnet4");
    expect(wallet.xPub.startsWith("tpub")).toBe(true);
    expect(wallet.getDepositAddress().startsWith("bchtest:")).toBe(true);
    expect(wallet.toDbString()).toBe(
      `hd:testnet4:${mnemonic}:m/44'/145'/0':0:0`,
    );
  } finally {
    await wallet.stop();
    await provider.disconnect();
  }
});

test("a registered network takes WIFs of its key version", async () => {
  const wallet = await Wallet.fromId(`wif:testnet4:${testnetWif}`, options);
  expect(wallet.privateKeyWif).toBe(testnetWif);
  const chipnet = await Wallet.fromWIF(testnetWif, { network: "testnet" });
  expect(wallet.cashaddr).toBe(chipnet.cashaddr);

  await expect(
    Wallet.fromWIF(
      "KysvoRyDkxQycBGj49K8oC3minAfoXnVmkcgx6UsZx3g2VvyGCAa",
      options,
    ),
  ).rejects.toThrow("WIF is for mainnet, expected testnet4");
});

test("the same seed has its own cache record, and an unknown network's id is unreadable", () => {
  const testnet = walletCacheIdFromWalletId(`hd:testnet:${mnemonic}`);
  const registered = walletCacheIdFromWalletId(`hd:testnet4:${mnemonic}`);
  expect(registered).toBeDefined();
  expect(registered).not.toBe(testnet);

  _resetRegisteredNetworks();
  expect(() => walletCacheIdFromWalletId(`hd:testnet4:${mnemonic}`)).toThrow(
    InvalidWalletIdError,
  );
});

test("named wallets are stored in the network's own database", async () => {
  BaseWallet.StorageProvider = IndexedDBProvider;
  const name = `registered-${Math.random()}`;
  const wallet = await Wallet.named(name, options);
  expect(await namedWalletExists(name, "bchtest4")).toBe(true);
  expect(await namedWalletExists(name, "bchtest")).toBe(false);

  const loaded = await Wallet.named(name, options);
  expect(loaded.cashaddr).toBe(wallet.cashaddr);
  await expect(
    Wallet.fromId(`named:testnet4:${name}:bchtest`, options),
  ).rejects.toThrow("can only name the database bchtest4");

  await expect(
    saveNamedWallet(name, wallet.toDbString(), "bchtest"),
  ).rejects.toBeInstanceOf(InvalidWalletIdError);
  await expect(
    saveNamedWallet(name, `wif:testnet:${testnetWif}`, "bchtest4"),
  ).rejects.toBeInstanceOf(InvalidWalletIdError);
  await wallet.stop();
  await loaded.stop();
});

test("a registered network has its own servers and global provider", () => {
  expect(getDefaultServers("testnet4")).toEqual(testnet4.servers);
  process.env.ELECTRUM_TESTNET4 = "wss://env.example:1";
  expect(getDefaultServers("testnet4")).toEqual(["wss://env.example:1"]);
  DefaultProvider.servers.testnet4 = "wss://example.com:777";
  expect(getDefaultServers("testnet4")).toEqual(["wss://example.com:777"]);

  const provider = {} as ElectrumNetworkProvider;
  setGlobalProvider("testnet4", provider);
  try {
    expect(getGlobalProvider("testnet4")).toBe(provider);
    expect(getGlobalProvider("testnet")).not.toBe(provider);
  } finally {
    removeGlobalProvider("testnet4");
  }
});
