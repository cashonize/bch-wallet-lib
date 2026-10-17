import { bchParam } from "../chain.js";
import { Config } from "../config.js";
import { default as NetworkProvider } from "./NetworkProvider.js";

// 1 sat/byte, the network's minrelaytxfee: below it a transaction does not propagate
const MinRelayFeePerByte = 1;

// The server's rate per provider, so that a wallet moved to another server (setProvider) asks that server
const relayFeeCache = new WeakMap<NetworkProvider, number>();

// The fee rate for a send in satoshis per byte: Config.RelayFeePerByte, or the server's blockchain.relayfee
// bounded to [1, Config.MaxRelayFeePerByte], since an unchecked server rate would set what the wallet
// burns in fees (mainnet-js#254)
export async function getRelayFeeCache(provider: NetworkProvider) {
  if (Config.RelayFeePerByte !== undefined) return Config.RelayFeePerByte;

  let serverFeePerByte = relayFeeCache.get(provider);
  if (serverFeePerByte === undefined) {
    const relayFeePerKbInCoins = await provider.getRelayFee();
    serverFeePerByte = MinRelayFeePerByte;
    if (
      typeof relayFeePerKbInCoins === "number" &&
      Number.isFinite(relayFeePerKbInCoins)
    ) {
      serverFeePerByte =
        Math.round(relayFeePerKbInCoins * Number(bchParam.subUnits)) / 1000;
    } else {
      console.warn("Couldn't get min relay fee, using default instead");
    }
    relayFeeCache.set(provider, serverFeePerByte);
  }

  return Math.min(
    Math.max(serverFeePerByte, MinRelayFeePerByte),
    Config.MaxRelayFeePerByte,
  );
}
