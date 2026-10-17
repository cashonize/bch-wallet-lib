import { Network } from "../src/interface.js";
import * as connection from "../src/network/Connection.js";
import { getGlobalProvider } from "../src/network/default.js";
import { initMockProvider } from "../src/network/MockNetworkProvider.js";

// The suite's provider setup: with USE_MOCK_PROVIDER the regtest provider is a mem-cash chain and
// the other networks are left alone, otherwise the library's own initProviders
const useMock = !!process.env.USE_MOCK_PROVIDER;

export async function initProviders(networks?: Network[]) {
  if (!useMock) return connection.initProviders(networks);
  if (networks && !networks.includes(Network.REGTEST)) return;
  if (!getGlobalProvider(Network.REGTEST)) await initMockProvider();
}

export async function disconnectProviders(networks?: Network[]) {
  if (useMock) return;
  return connection.disconnectProviders(networks);
}
