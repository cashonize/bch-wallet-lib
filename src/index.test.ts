import * as entry from "./index.js";
import type { HDWalletOptions } from "./index.js";

test("the entry exports the HD wallet's gap limit and branch constants", () => {
  expect(entry.GAP_SIZE).toBe(20);
  expect(entry.DEFAULT_BRANCHES).toEqual([0, 1]);
  expect(entry.DEPOSIT_BRANCH).toBe(0);
  expect(entry.CHANGE_BRANCH).toBe(1);
  const options: HDWalletOptions = { branches: [...entry.DEFAULT_BRANCHES] };
  expect(options.branches).toEqual([0, 1]);
});
