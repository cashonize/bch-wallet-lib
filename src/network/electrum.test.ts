import { Network } from "../interface.js";
import { ElectrumTransport } from "./ElectrumTransport.js";
import { createProvider, getNetworkProvider } from "./index.js";
import { liveTests } from "#test/live.js";

test.skipIf(!liveTests)(
  "Should get a transaction with a bare electrum transport",
  async () => {
    const transport = new ElectrumTransport("wss://fulcrum.pat.mn:50004");
    await transport.connect();
    const transactionID =
      "4db095f34d632a4daf942142c291f1f2abb5ba2e1ccac919d85bdc2f671fb251";
    const transactionHex = await transport.request(
      "blockchain.transaction.get",
      [transactionID],
    );
    expect(typeof transactionHex).toBe("string");
    expect((transactionHex as string).length).toBeGreaterThan(0);
    await transport.close();
  },
);

test.skipIf(!liveTests)("Should get a transaction with provider", async () => {
  const provider = getNetworkProvider(Network.MAINNET);
  const transactionID =
    "4db095f34d632a4daf942142c291f1f2abb5ba2e1ccac919d85bdc2f671fb251";
  const transactionHex = await provider.getRawTransaction(transactionID);
  expect(transactionHex.length).toBeGreaterThan(0);
  await provider.disconnect();
});

test.skipIf(!liveTests)(
  "Should propagate electrum error for non-existent transaction",
  async () => {
    const zeroTxId =
      "0000000000000000000000000000000000000000000000000000000000000000";

    const transport = new ElectrumTransport("wss://fulcrum.pat.mn:50004");
    await transport.connect();
    try {
      await transport.request("blockchain.transaction.get", [zeroTxId]);
      throw new Error("Expected request to throw");
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(
        "No such mempool or blockchain transaction",
      );
    } finally {
      await transport.close();
    }
  },
);

test.skipIf(!liveTests)(
  "Should throw user-friendly error for non-existent transaction via provider",
  async () => {
    const zeroTxId =
      "0000000000000000000000000000000000000000000000000000000000000000";
    const provider = await createProvider(
      Network.MAINNET,
      "wss://fulcrum.pat.mn:50004",
    );
    try {
      await provider.getRawTransaction(zeroTxId);
      throw new Error("Expected getRawTransaction to throw");
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("Could not decode transaction");
      expect(error.message).toContain("might not exist");
    } finally {
      await provider.disconnect();
    }
  },
);
