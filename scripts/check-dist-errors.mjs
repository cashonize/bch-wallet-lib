// Fails when an error the built package throws is not `instanceof` the class its main entry
// exports, as callers tell errors apart that way. The wallet runs on a mem-cash chain behind the
// entry's ElectrumNetworkProvider, as an app's tests would. Run after `pnpm build`.
import { asTransport, createIndexer } from "@paryonusd/mem-cash";
import { createTxVerifier } from "@paryonusd/mem-cash/validation";
import { fileURLToPath } from "node:url";
import {
  BroadcastRejectedError,
  BroadcastTimeoutError,
  ElectrumNetworkProvider,
  InsufficientFundsError,
  NetworkType,
  setGlobalProvider,
  WatchOnlyError,
} from "bch-wallet-lib";
// off the entry, as the regtest classes are test infrastructure; the same built modules
import { RegTestWallet } from "../dist/wallet/Wif.js";

// the funded test wallet
process.loadEnvFile(fileURLToPath(new URL("../.env.regtest", import.meta.url)));
const chain = createIndexer({
  addressPrefix: "bchreg",
  verifier: createTxVerifier({ vmVersion: "BCH_2026_05" }),
});
await chain.request("test.set_chain_tip", [200, 1700000200]);
await chain.request("test.add_utxo", [
  process.env.ADDRESS,
  { vout: 0, satoshis: 5_000_000_000, height: 1 },
]);
const provider = new ElectrumNetworkProvider(
  asTransport(chain),
  NetworkType.Regtest,
);
setGlobalProvider(NetworkType.Regtest, provider);
const alice = await RegTestWallet.fromId(process.env.ALICE_ID);
const wallet = await RegTestWallet.newRandom();
await alice.send({ cashaddr: wallet.cashaddr, value: 10_000n });

const caught = (promise) =>
  promise.then(
    () => undefined,
    (error) => error,
  );
const problems = [];

const shortfall = await caught(
  wallet.send({ cashaddr: wallet.cashaddr, value: 20_000n }),
);
if (!(shortfall instanceof InsufficientFundsError)) {
  problems.push(`a shortfall threw ${shortfall}`);
}

const watching = await RegTestWallet.fromId(`watch:regtest:${wallet.cashaddr}`);
const unsigned = await caught(
  watching.send({ cashaddr: wallet.cashaddr, value: 1_000n }),
);
if (!(unsigned instanceof WatchOnlyError)) {
  problems.push(`a watch-only send threw ${unsigned}`);
}
await watching.stop();

// two spends of the one coin: the second is refused as a mempool conflict
const first = await wallet.send(
  { cashaddr: wallet.cashaddr, value: 5_000n },
  {
    broadcast: false,
  },
);
const second = await wallet.send(
  { cashaddr: wallet.cashaddr, value: 6_000n },
  {
    broadcast: false,
  },
);
await provider.sendRawTransaction(first.transaction);
const refusal = await caught(provider.sendRawTransaction(second.transaction));
if (!(refusal instanceof BroadcastRejectedError)) {
  problems.push(`a refused broadcast threw ${refusal}`);
}

// a server that takes the broadcast, never reports it and does not hold it
const silent = new ElectrumNetworkProvider(
  {
    connect: async () => {},
    close: async () => {},
    request: async (method) => {
      if (method === "blockchain.transaction.broadcast") return "";
      throw Object.assign(new Error("No such transaction"), { code: 2 });
    },
    subscribe: async () => async () => {},
  },
  NetworkType.Regtest,
);
const unreported = await caught(
  silent.sendRawTransaction(first.transaction, { statusTimeout: 10 }),
);
if (!(unreported instanceof BroadcastTimeoutError)) {
  problems.push(`an unreported broadcast threw ${unreported}`);
}

await alice.stop();
await wallet.stop();
await provider.disconnect();
if (problems.length) {
  console.error(
    `Errors are not instances of the entry's classes:\n${problems.join("\n")}`,
  );
  process.exit(1);
}
console.log("Errors are instances of the classes the entry exports.");
