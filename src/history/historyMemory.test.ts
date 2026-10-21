import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { RegTestWallet } from "../wallet/Wif.js";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

test("a history keeps its hex strings flat", async () => {
  const miner = await RegTestWallet.fromWIF(process.env.PRIVATE_WIF!);
  const receiver = await RegTestWallet.newRandom();
  const outputs = 1000;
  await miner.send(
    Array.from({ length: outputs }, () => ({
      cashaddr: receiver.cashaddr!,
      value: 1000n,
    })),
  );
  // what the history holds is what freeing it gives back; loaded in a function of its own, which
  // holds the only reference
  const heapWithHistory = async () => {
    const history = await receiver.getHistory();
    expect(history[0].outputs.length).toBe(outputs + 1);
    gc();
    return process.memoryUsage().heapUsed;
  };
  const withHistory = await heapWithHistory();
  gc();
  const perOutput = (withHistory - process.memoryUsage().heapUsed) / outputs;

  // each output keeps its locking bytecode as hex: built two characters at a time, as libauth's
  // binToHex does, that is about 1 KB of string pieces per output instead of about 100 B
  expect(perOutput).toBeLessThan(400);
});
