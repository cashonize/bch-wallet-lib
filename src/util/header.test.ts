import { disconnectProviders, initProviders } from "#test/providers.js";
import { Wallet } from "../wallet/Wif.js";
import { liveTests } from "#test/live.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe("header tests", () => {
  it.skipIf(!liveTests)("decodeHeader", async () => {
    const wallet = await Wallet.newRandom();
    const headers = await wallet.provider!.getHeaders([854724]);
    const header = headers.get(854724)!;
    expect(header.version).toBe(868515840);
    expect(header.previousBlockHash).toBe(
      "00000000000000000017355b8414bd227b3bf9696b5ab190b5a5354e1da87496",
    );
    expect(header.merkleRoot).toBe(
      "34acfabbc61feb09c35d83fd9ff3cd21f026deb0fdc6607fa8fd826c778b8a12",
    );
    expect(header.timestamp).toBe(1721118526);
    expect(header.bits).toBe(402805293);
    expect(header.nonce).toBe(2403512909);
    expect(header.height).toBe(854724);
  });
});
