import { encodeTransactionOutput } from "@bitauth/libauth";
import { TokenSendRequest } from "../wallet/model.js";
import { prepareTokenOutputs } from "./Wif.js";

const category = "11".repeat(32);
const cashaddr = "bchreg:zpttdv3qg2usm4nm7talhxhl05mlhms3ysjm0q59vu";

describe("prepareTokenOutputs", () => {
  test("gives an NFT without a commitment empty commitment bytes", () => {
    // an untyped caller can leave out the commitment
    const request = new TokenSendRequest({
      cashaddr,
      category,
      nft: { capability: "none" } as any,
    });
    const output = prepareTokenOutputs(request);
    expect(output.token!.nft!.commitment).toEqual(Uint8Array.of());
    expect(() => encodeTransactionOutput(output)).not.toThrow();
  });
});
