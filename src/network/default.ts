import { Network } from "../interface.js";
import { getDefaultServers, parseServers } from "./configuration.js";
import { networkTickerMap } from "./constant.js";
import { default as ElectrumNetworkProvider } from "./ElectrumNetworkProvider.js";
import {
  ElectrumTransport,
  type ElectrumTransportOptions,
} from "./ElectrumTransport.js";
import {
  FailoverTransport,
  type FailoverTransportOptions,
} from "./FailoverTransport.js";

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

/**
 * A provider over an ordered list of servers that moves to the next one when the server in use is
 * lost, lags or (with `staleTipSeconds`) serves a stale tip; see FailoverTransport. With one server
 * it never contacts another. `onServerChange` tells which server is in use.
 */
export async function createFailoverProvider(
  network: Network,
  servers: string[],
  options?: FailoverTransportOptions,
): Promise<ElectrumNetworkProvider> {
  const transport = new FailoverTransport(servers, options);
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
