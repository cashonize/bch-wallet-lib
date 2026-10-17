import { bchParam } from "../chain.js";
import { Config } from "../config.js";
import { default as NetworkProvider } from "./NetworkProvider.js";

// Per provider, so that a wallet moved to another server (setProvider) asks that server
const relayFeeCache = new WeakMap<NetworkProvider, number>();

// The fee rate for a send in satoshis per byte: Config.RelayFeePerByte, or the server's blockchain.relayfee
export async function getRelayFeeCache(provider: NetworkProvider) {
  if (Config.RelayFeePerByte !== undefined) return Config.RelayFeePerByte;

  let feePerByte = relayFeeCache.get(provider);
  if (feePerByte !== undefined) return feePerByte;

  const relayFeePerKbInCoins = await provider.getRelayFee();
  if (typeof relayFeePerKbInCoins === "number") {
    feePerByte =
      Math.round(relayFeePerKbInCoins * Number(bchParam.subUnits)) / 1000;
  } else {
    console.warn("Couldn't get min relay fee, using default instead");
    feePerByte = 1;
  }
  relayFeeCache.set(provider, feePerByte);
  return feePerByte;
}
