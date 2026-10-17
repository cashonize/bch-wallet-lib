import { Network } from "../src/interface.js";
import * as connection from "../src/network/Connection.js";
import { getGlobalProvider } from "../src/network/default.js";
import { initMockProvider } from "../src/network/MockNetworkProvider.js";
import { liveTests } from "./live.js";

// The suite's provider setup: with USE_MOCK_PROVIDER the regtest provider is a mem-cash chain and
// the other networks are left alone, otherwise the library's own initProviders, for the regtest
// alone unless LIVE_TESTS asks for the public networks too
const useMock = !!process.env.USE_MOCK_PROVIDER;

export async function initProviders(networks?: Network[]) {
  if (!useMock) {
    if (!networks && !liveTests) networks = [Network.REGTEST];
    return connection.initProviders(networks);
  }
  if (networks && !networks.includes(Network.REGTEST)) return;
  if (!getGlobalProvider(Network.REGTEST)) await initMockProvider();
}

export async function disconnectProviders(networks?: Network[]) {
  if (useMock) return;
  return connection.disconnectProviders(networks);
}
