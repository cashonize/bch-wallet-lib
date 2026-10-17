import { decodeTransaction, hexToBin } from "@bitauth/libauth";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { RegTestWallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

test("buildUnsigned wins over broadcast: false", async () => {
  const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
  const bob = await RegTestWallet.newRandom();

  const response = await alice.send([[bob.cashaddr, 10_000n]], {
    buildUnsigned: true,
    broadcast: false,
  });
  expect(response.txId).toBeUndefined();
  expect(response.transaction).toBeUndefined();
  const decoded = decodeTransaction(hexToBin(response.unsignedTransaction!));
  if (typeof decoded === "string") throw new Error(decoded);
  expect(decoded.inputs[0].unlockingBytecode.length).toBe(0);
  expect(response.sourceOutputs!.length).toBe(decoded.inputs.length);
});
