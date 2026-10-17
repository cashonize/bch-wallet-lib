import { Network } from "../interface.js";
import { getRuntimePlatform } from "../util/index.js";
import * as primary from "./constant.js";

/**
 * Servers that override the built-in ones per network: a URL (`wss://host:port`), several URLs
 * separated by commas, or a list of URLs. A list is tried in order when connecting.
 */
export class DefaultProvider {
  static servers: { [name: string]: string | string[] } = {
    mainnet: "",
    testnet: "",
    regtest: "",
  };
}

/** Normalizes a server setting to a list of URLs; an empty setting gives an empty list. */
export function parseServers(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : (value ?? "").split(",");
  return values.map((url) => url.trim()).filter((url) => url.length > 0);
}

export function getDefaultServers(network: Network): string[] {
  let env: any;
  if (getRuntimePlatform() == "node") {
    env = process.env;
  } else {
    env = {};
  }

  const envNames = {
    mainnet: "ELECTRUM",
    testnet: "ELECTRUM_TESTNET",
    regtest: "ELECTRUM_REGTEST",
  };

  const configured = parseServers(DefaultProvider.servers[network]);
  if (configured.length > 0) return configured;
  const fromEnv = parseServers(env[envNames[network]]);
  if (fromEnv.length > 0) return fromEnv;
  return primary.defaultServers[network];
}
