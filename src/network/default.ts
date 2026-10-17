import { Network } from "../interface.js";
import { getDefaultServers, parseServers } from "./configuration.js";
import { networkTickerMap } from "./constant.js";
import { default as ElectrumNetworkProvider } from "./ElectrumNetworkProvider.js";
import {
  ElectrumTransport,
  type ElectrumTransportOptions,
} from "./ElectrumTransport.js";

export function setGlobalProvider(
  network: Network,
  provider: ElectrumNetworkProvider,
): ElectrumNetworkProvider {
  const accessor = networkTickerMap[network];
  globalThis[accessor] = provider;
  return provider;
}

export function getGlobalProvider(
  network: Network,
): ElectrumNetworkProvider | undefined {
  const accessor = networkTickerMap[network];
  return globalThis[accessor];
}

export function removeGlobalProvider(network: Network): void {
  const accessor = networkTickerMap[network];
  if (accessor in globalThis) {
    delete globalThis[accessor];
  }
}

/**
 * A provider for the given servers, or else the network's defaults (see DefaultProvider). Servers are
 * a URL (`wss://host:port`), several separated by commas, or a list; a list is tried in order when
 * connecting.
 */
export async function createProvider(
  network: Network = Network.MAINNET,
  servers?: string | string[],
  options?: ElectrumTransportOptions,
): Promise<ElectrumNetworkProvider> {
  let urls = getDefaultServers(network);
  if (servers !== undefined) urls = parseServers(servers);
  const transport = new ElectrumTransport(urls, options);
  return new ElectrumNetworkProvider(transport, network);
}

export function getNetworkProvider(
  network: Network = Network.MAINNET,
): ElectrumNetworkProvider {
  const globalProvider = getGlobalProvider(network);
  if (globalProvider) {
    return globalProvider;
  }

  const transport = new ElectrumTransport(getDefaultServers(network));
  const provider = new ElectrumNetworkProvider(transport, network);
  setGlobalProvider(network, provider);
  return provider;
}
