import { disconnectProviders, initProviders } from "#test/providers.js";
import { RegTestWallet, Wallet } from "../wallet/Wif.js";
import {
  deriveCashaddr,
  isTokenaddr,
  toCashaddr,
  toTokenaddr,
} from "./deriveCashaddr.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

const p2shAddress = "bitcoincash:ppvamrzvn62c85tv0y4ncdxyy77csxk7qgcjrpwp98";
const p2shTokenAddress =
  "bitcoincash:rpvamrzvn62c85tv0y4ncdxyy77csxk7qglcslq865";

const p2sh32Address =
  "bitcoincash:pww87w869tuuzw4avtyxtlwhq32l25xkyy9n3xhzfelhj0d3vm8xx5auz6k7z";
const p2sh32TokenAddress =
  "bitcoincash:rww87w869tuuzw4avtyxtlwhq32l25xkyy9n3xhzfelhj0d3vm8xxxwqrrh8f";

test("Should derive cashaddr", async () => {
  const wallet = await Wallet.newRandom();
  expect(deriveCashaddr(wallet.privateKey!, wallet.networkPrefix)).toBe(
    wallet.cashaddr!,
  );
});

test("Test address conversion", async () => {
  const wallet = await RegTestWallet.fromId(
    `watch:regtest:${process.env.ADDRESS!}`,
  );

  // p2pkh
  expect(toTokenaddr(wallet.cashaddr)).toBe(wallet.tokenaddr);
  expect(toCashaddr(wallet.cashaddr)).toBe(wallet.cashaddr);

  // p2pkh with tokens
  expect(toCashaddr(wallet.tokenaddr)).toBe(wallet.cashaddr);
  expect(toTokenaddr(wallet.tokenaddr)).toBe(wallet.tokenaddr);

  // p2sh
  expect(toCashaddr(p2shAddress)).toBe(p2shAddress);
  expect(toTokenaddr(p2shAddress)).toBe(p2shTokenAddress);

  // p2sh with tokens
  expect(toCashaddr(p2shTokenAddress)).toBe(p2shAddress);
  expect(toTokenaddr(p2shTokenAddress)).toBe(p2shTokenAddress);

  // p2sh32
  expect(toCashaddr(p2sh32Address)).toBe(p2sh32Address);
  expect(toTokenaddr(p2sh32Address)).toBe(p2sh32TokenAddress);

  // p2sh32 with tokens
  expect(toCashaddr(p2sh32TokenAddress)).toBe(p2sh32Address);
  expect(toTokenaddr(p2sh32TokenAddress)).toBe(p2sh32TokenAddress);

  expect(toCashaddr(wallet.tokenaddr)).toBe(
    "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0",
  );
  expect(toTokenaddr(wallet.cashaddr)).toBe(
    "bchreg:zpttdv3qg2usm4nm7talhxhl05mlhms3ysjm0q59vu",
  );

  expect(isTokenaddr(wallet.cashaddr)).toBe(false);
  expect(isTokenaddr(wallet.tokenaddr)).toBe(true);
});
