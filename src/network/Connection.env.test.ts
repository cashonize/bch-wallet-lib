import { Network } from "../interface.js";
import { disconnectProviders } from "./Connection.js";

// A browser has no global `process` unless the bundler defines one
test("disconnectProviders works without a global process", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process")!;
  delete (globalThis as { process?: unknown }).process;
  let result: Promise<void>;
  try {
    result = disconnectProviders([Network.REGTEST]);
  } finally {
    Object.defineProperty(globalThis, "process", descriptor);
  }
  await expect(result).resolves.toBeUndefined();
});
