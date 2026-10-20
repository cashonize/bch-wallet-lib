import { Network } from "../src/interface.js";
import { getNetworkProvider } from "../src/network/default.js";

// Mines blocks on the regtest provider: the mock chain in mock mode, the Docker node otherwise
export async function mine({
  cashaddr,
  blocks,
}: {
  cashaddr: string;
  blocks: number;
}): Promise<string[]> {
  return getNetworkProvider(Network.REGTEST).mine(cashaddr, blocks);
}
