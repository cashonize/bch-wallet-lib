import { getDustThreshold } from "@bitauth/libauth";
import { NFTCapability } from "../interface.js";
import { TokenSendRequest } from "../wallet/model.js";
import { tokenOutput } from "./tokenOutput.js";

const category = "11".repeat(32);
const cashaddr = "bchreg:zpttdv3qg2usm4nm7talhxhl05mlhms3ysjm0q59vu";
const longNft = {
  capability: NFTCapability.none,
  commitment: "ab".repeat(128),
};

describe("tokenOutput", () => {
  test("without a value, a fungible output holds 1000 sats", () => {
    const output = tokenOutput(
      new TokenSendRequest({ cashaddr, category, amount: 100n }),
    );
    expect(output.valueSatoshis).toBe(1000n);
  });

  test("without a value, an output whose dust limit is above 1000 sats holds its dust limit", () => {
    const output = tokenOutput(
      new TokenSendRequest({
        cashaddr,
        category,
        amount: 2n ** 63n - 1n,
        nft: longNft,
      }),
    );
    expect(getDustThreshold(output)).toBeGreaterThan(1000n);
    expect(output.valueSatoshis).toBe(getDustThreshold(output));
  });

  test("a value the request names is kept, even below the dust limit", () => {
    const output = tokenOutput(
      new TokenSendRequest({
        cashaddr,
        category,
        amount: 1n,
        nft: longNft,
        value: 800n,
      }),
    );
    expect(output.valueSatoshis).toBe(800n);
  });
});
