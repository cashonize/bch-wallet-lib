import { binToBase64, utf8ToBin } from "@bitauth/libauth";
import { Network } from "../src/interface.js";
import { getNetworkProvider } from "../src/network/default.js";
import { MockNetworkProvider } from "../src/network/MockNetworkProvider.js";

// Mines blocks on the regtest provider: the mock chain in mock mode, the Docker node otherwise
export async function mine({
  cashaddr,
  blocks,
}: {
  cashaddr: string;
  blocks: number;
}): Promise<string[]> {
  const provider = getNetworkProvider(Network.REGTEST);
  if (provider instanceof MockNetworkProvider) {
    return provider.mine(cashaddr, blocks);
  }
  return mineOverRpc(cashaddr, blocks);
}

// Fulcrum's daemon.passthrough takes named params, which electrum-cash cannot send, so this calls
// generatetoaddress on the node's own RPC, with the RPC_* settings of the regtest
async function mineOverRpc(
  cashaddr: string,
  blocks: number,
): Promise<string[]> {
  const env = process.env;
  const credentials = utf8ToBin(`${env.RPC_USER}:${env.RPC_PASS}`);
  const init = {
    method: "POST",
    headers: {
      Authorization: `Basic ${binToBase64(credentials)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "mine",
      method: "generatetoaddress",
      params: [blocks, cashaddr],
    }),
  };

  let unreachable: unknown;
  for (const host of ["127.0.0.1", "host.docker.internal"]) {
    let response: Response;
    try {
      response = await fetch(`http://${host}:${env.RPC_PORT}/`, init);
    } catch (error) {
      unreachable = error;
      continue;
    }
    const { result, error } = await response.json();
    if (error) throw new Error(`generatetoaddress failed: ${error.message}`);
    return result;
  }
  throw new Error("The regtest node's RPC is not reachable.", {
    cause: unreachable,
  });
}
