import { Network } from "../interface.js";
import { Wallet } from "../wallet/Wif.js";
import * as config from "./configuration.js";
import * as primary from "./constant.js";

afterEach(() => {
  // Restore env vars to prevent leaking fake servers to subsequent test files
  delete process.env.ELECTRUM;
  delete process.env.ELECTRUM_TESTNET;
  delete process.env.ELECTRUM_REGTEST;
  config.DefaultProvider.servers.mainnet = "";
});

test("Should get electrum settings from defaults", async () => {
  expect(config.getDefaultServers(Network.MAINNET)).toEqual(
    primary.mainnetServers,
  );
  expect(config.getDefaultServers(Network.TESTNET)).toEqual(
    primary.testnetServers,
  );
  expect(config.getDefaultServers(Network.REGTEST)).toEqual(
    primary.regtestServers,
  );
});

test("Should get electrum settings from DefaultProvider", async () => {
  config.DefaultProvider.servers.mainnet = "wss://example.com:777";

  expect(config.getDefaultServers(Network.MAINNET)).toEqual([
    "wss://example.com:777",
  ]);
  expect(config.getDefaultServers(Network.TESTNET)).toEqual(
    primary.testnetServers,
  );

  config.DefaultProvider.servers.mainnet = [
    "wss://example.com:777",
    "wss://example.dk:777",
  ];
  expect(config.getDefaultServers(Network.MAINNET)).toEqual([
    "wss://example.com:777",
    "wss://example.dk:777",
  ]);
});

test("Should prefer DefaultProvider over env", async () => {
  process.env.ELECTRUM = "wss://env.example.com:1234";
  config.DefaultProvider.servers.mainnet = ["wss://example.com:777"];
  expect(config.getDefaultServers(Network.MAINNET)).toEqual([
    "wss://example.com:777",
  ]);
});

test("Should get electrum settings from env", async () => {
  process.env.ELECTRUM = "wss://example.com:1234";
  process.env.ELECTRUM_TESTNET =
    "wss://test.example.com:1234, wss://test.example.dk:1234";
  process.env.ELECTRUM_REGTEST = "ws://reg.example.com:1234";
  expect(config.getDefaultServers(Network.MAINNET)).toEqual([
    "wss://example.com:1234",
  ]);
  expect(config.getDefaultServers(Network.TESTNET)).toEqual([
    "wss://test.example.com:1234",
    "wss://test.example.dk:1234",
  ]);
  expect(config.getDefaultServers(Network.REGTEST)).toEqual([
    "ws://reg.example.com:1234",
  ]);
});

test("Should get electrum settings from env, comma separated", async () => {
  process.env.ELECTRUM =
    "wss://bch.imaginary.cash:50004,wss://electrum.imaginary.cash:50004";

  const wallet = await Wallet.newRandom();
  expect(await wallet.getBalance()).toBe(0n);
  await wallet.provider!.disconnect();
});
