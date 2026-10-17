// Fails when an error the built package throws is not `instanceof` the class its main entry
// exports, as callers tell errors apart that way. The wallet runs on the mock chain from the
// ./mock entry, as an app's tests would. Run after `pnpm build`.
import { fileURLToPath } from "node:url";
import {
  BroadcastRejectedError,
  InsufficientFundsError,
  RegTestWallet,
} from "bch-wallet-lib";
import { initMockProvider } from "bch-wallet-lib/mock";

// the funded test wallet
process.loadEnvFile(fileURLToPath(new URL("../.env.regtest", import.meta.url)));
const provider = await initMockProvider();
const alice = await RegTestWallet.fromId(process.env.ALICE_ID);
const wallet = await RegTestWallet.newRandom();
await alice.send([[wallet.cashaddr, 10_000n]]);

const caught = (promise) =>
  promise.then(
    () => undefined,
    (error) => error,
  );
const problems = [];

const shortfall = await caught(wallet.send([[wallet.cashaddr, 20_000n]]));
if (!(shortfall instanceof InsufficientFundsError)) {
  problems.push(`a shortfall threw ${shortfall}`);
}

// two spends of the one coin: the second is refused as a mempool conflict
const first = await wallet.send([[wallet.cashaddr, 5_000n]], {
  broadcast: false,
});
const second = await wallet.send([[wallet.cashaddr, 6_000n]], {
  broadcast: false,
});
await provider.sendRawTransaction(first.transaction);
const refusal = await caught(provider.sendRawTransaction(second.transaction));
if (!(refusal instanceof BroadcastRejectedError)) {
  problems.push(`a refused broadcast threw ${refusal}`);
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
