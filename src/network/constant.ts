export const networkTickerMap = {
  mainnet: "BCH",
  testnet: "tBCH",
  regtest: "rBCH",
};

export const mainnetServers = [
  "wss://bch.imaginary.cash:50004",
  "wss://electrum.imaginary.cash:50004",
  "wss://fulcrum.pat.mn:50004",
];

// chipnet
export const testnetServers = [
  "wss://chipnet.bch.ninja:50004",
  "wss://chipnet.imaginary.cash:50004",
  "wss://chipnet.c3-soft.com:64004",
];

export const regtestServers = [
  "ws://127.0.0.1:60003",
  "ws://host.docker.internal:60003",
];

export const defaultServers = {
  mainnet: mainnetServers,
  testnet: testnetServers,
  regtest: regtestServers,
};
