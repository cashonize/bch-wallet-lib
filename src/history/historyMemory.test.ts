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
    gc();
    const heap = process.memoryUsage().heapUsed;
    // read after the measurement, so the history is certainly alive while it is taken
    return { heap, outputCount: history[0].outputs.length };
  };
  const { heap: withHistory, outputCount } = await heapWithHistory();
  expect(outputCount).toBe(outputs + 1);
  gc();
  const perOutput = (withHistory - process.memoryUsage().heapUsed) / outputs;

  // each output keeps its locking bytecode as hex: about 1.2 KB per output built two characters at
  // a time, as libauth's binToHex does, about 190 B flat; the upper bound leaves room for the heap
  // measurement's noise (runs reach about 400 B), the lower bound fails a measurement that
  // measured nothing
  expect(perOutput).toBeLessThan(600);
  expect(perOutput).toBeGreaterThan(50);
});
