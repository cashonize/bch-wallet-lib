import { bchParam } from "../chain.js";
import { Config } from "../config.js";
import ElectrumNetworkProvider from "./ElectrumNetworkProvider.js";

// 1 sat/byte, the network's minrelaytxfee: below it a transaction does not propagate
const MinRelayFeePerByte = 1;

// The server's rate per provider, so that a wallet moved to another server (setProvider) asks that server
const relayFeeCache = new WeakMap<ElectrumNetworkProvider, number>();

// Config is assigned by the app, possibly from untyped code or stored settings, so a bad value is
// caught here and named rather than surfacing as a broken fee calculation
function checkFeeSetting(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Config.${name} must be a finite, non-negative number of satoshis per byte, got ${String(value)}`,
    );
  }
  return value;
}

// The fee rate for a send in satoshis per byte, never below 1: Config.RelayFeePerByte, or the server's
// blockchain.relayfee. A server rate above Config.MaxRelayFeePerByte is ignored rather than capped, since
// an unchecked or capped server rate would let the server set what the wallet burns in fees (mainnet-js#254)
export async function getRelayFeeCache(provider: ElectrumNetworkProvider) {
  const maxFeePerByte = checkFeeSetting(
    "MaxRelayFeePerByte",
    Config.MaxRelayFeePerByte,
  );
  if (Config.RelayFeePerByte !== undefined) {
    const feePerByte = checkFeeSetting(
      "RelayFeePerByte",
      Config.RelayFeePerByte,
    );
    return Math.max(feePerByte, MinRelayFeePerByte);
  }

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
    if (serverFeePerByte > maxFeePerByte) {
      console.warn(
        `Ignoring the server's relay fee of ${serverFeePerByte} sat/byte, above Config.MaxRelayFeePerByte (${maxFeePerByte})`,
      );
    }
    relayFeeCache.set(provider, serverFeePerByte);
  }

  let feePerByte = serverFeePerByte;
  if (feePerByte > maxFeePerByte) feePerByte = MinRelayFeePerByte;
  return Math.max(feePerByte, MinRelayFeePerByte);
}
