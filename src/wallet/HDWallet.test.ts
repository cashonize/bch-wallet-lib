import {
  assertSuccess,
  binToHex,
  decodeTransaction,
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  encodeCashAddress,
  hash160,
  HdPrivateNodeValid,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1,
} from "@bitauth/libauth";
import { stringify } from "../cache/walletCache.js";
import { Config } from "../config.js";
import { NFTCapability, Utxo } from "../interface.js";
import { mine } from "#test/mine.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { getTokenBalance, getTokenUtxos } from "#test/balances.js";
import { delay } from "../util/delay.js";
import { toTokenaddr } from "../util/deriveCashaddr.js";
import { getNextUnusedIndex, getNextUnusedIndices } from "../util/hd.js";
import { GAP_SIZE, HDWallet, RegTestHDWallet } from "./HDWallet.js";
import { InvalidRequestError } from "./errors.js";
import { TokenMintRequest, TokenSendRequest } from "./model.js";
import { RegTestWatchWallet } from "./Watch.js";
import { RegTestWallet, Wallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

const expectedXpub =
  "xpub6CGqRCnS5qDfyxtzV3y3tj8CY7qf3z3GiB2qnCUTdNkhpNxbLtobrU5ZXBVPG3rzPcBUpJAoj3K1u1jyDwKuduL71gLPm27Tckc85apgQRr";
const expectedXprv =
  "xprv9yHV1hFYFTfNmUpXP2S3XbBTz61AeXKRLx7Eyp4r53DiwadSoMVMJfm5fvtxBc3NFKfozcH42LM66Kb5VaxdLvGk43JWahCegx6iaEJbkB2";

describe("HDWallet", () => {
  it("should create a new HDWallet instance", async () => {
    // the xpub and xprv vectors are of the m/44'/0'/0' path
    const wallet = await Wallet.fromId(
      "seed:mainnet:divide battle bulb improve hockey favorite charge save merit fatal frog cage:m/44'/0'/0'/0/0",
    );
    const walletSeed = await HDWallet.fromId(
      `hd:mainnet:divide battle bulb improve hockey favorite charge save merit fatal frog cage:m/44'/0'/0'`,
    );
    const walletPriv = await HDWallet.fromId(`hd:mainnet:${expectedXprv}`);
    const walletPub = await HDWallet.fromId(`hd:mainnet:${expectedXpub}`);

    expect(walletSeed.xPub).toBe(expectedXpub);
    expect(walletSeed["xPriv"]).toBe(expectedXprv);
    expect(walletPriv.xPub).toBe(expectedXpub);
    expect(walletPriv["xPriv"]).toBe(expectedXprv);
    expect(walletPub.xPub).toBe(expectedXpub);

    expect(wallet.getDepositAddress()).toBe(walletSeed.getDepositAddress());
    expect(wallet.getDepositAddress()).toBe(walletPriv.getDepositAddress());
    expect(wallet.getDepositAddress()).toBe(walletPub.getDepositAddress());

    expect(walletSeed.getChangeAddress()).toBe(walletPriv.getChangeAddress());
    expect(walletSeed.getChangeAddress()).toBe(walletPub.getChangeAddress());
  });

  it("derives branch/index below a depth-4 or depth-5 node, as mainnet-js 3.1.7 did", async () => {
    // A stored id may hold a node deeper than an account (a depth-4 derivation path, or the
    // xpub of one); 3.1.7 derived `branch/index` below it like below any other node, and the
    // addresses of a stored id must not change.
    const mnemonic =
      "divide battle bulb improve hockey favorite charge save merit fatal frog cage";
    const root = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic);
    const addressAt = (path: string) =>
      assertSuccess(
        encodeCashAddress({
          prefix: "bitcoincash",
          type: "p2pkh",
          payload: hash160(
            secp256k1.derivePublicKeyCompressed(
              (deriveHdPath(root, path) as HdPrivateNodeValid).privateKey,
            ) as Uint8Array,
          ),
        }),
      ).address;

    for (const parent of ["m/44'/0'/0'/0", "m/44'/0'/0'/0/0"]) {
      const fromMnemonic = await HDWallet.fromId(
        `hd:mainnet:${mnemonic}:${parent}`,
      );
      const fromXPub = await HDWallet.fromId(`hd:mainnet:${fromMnemonic.xPub}`);
      try {
        for (const wallet of [fromMnemonic, fromXPub]) {
          expect([...wallet["branches"]]).toEqual([0, 1]);
          for (const i of [0, 1, 5]) {
            expect(wallet.getDepositAddress(i)).toBe(
              addressAt(`${parent}/0/${i}`),
            );
            expect(wallet.getChangeAddress(i)).toBe(
              addressAt(`${parent}/1/${i}`),
            );
          }
        }
      } finally {
        await fromMnemonic.stop();
        await fromXPub.stop();
      }
    }
  });

  it("should track arbitrary integer branches via the `branches` option", async () => {
    const mnemonic =
      "divide battle bulb improve hockey favorite charge save merit fatal frog cage";
    const wallet = await Wallet.fromId(`seed:mainnet:${mnemonic}`);

    // The static helpers don't expose `branches`; reach into initialize().
    const w = new HDWallet();
    await (w as any).initialize({
      mnemonic,
      branches: [0, 1, 7],
    });

    expect([...w["branches"]]).toEqual([0, 1, 7]);
    // Branch 7 derives at m/44'/0'/0'/7/N -- distinct from branches 0/1.
    const b0 = w.getAddressByBranch(0, 0);
    const b1 = w.getAddressByBranch(1, 0);
    const b7 = w.getAddressByBranch(7, 0);
    expect(b0).not.toBe(b1);
    expect(b0).not.toBe(b7);
    expect(b1).not.toBe(b7);

    // Deposit/change conveniences map to branches 0 and 1.
    expect(w.getDepositAddress(0)).toBe(b0);
    expect(w.getChangeAddress(0)).toBe(b1);

    // Asking for an untracked branch throws.
    expect(() => w.getAddressByBranch(99, 0)).toThrow(/not tracked/);

    // The branch-0 address matches the standard single-key wallet derivation.
    expect(w.getDepositAddress(0)).toBe(wallet.cashaddr);
  });

  it("refuses a branches list without the deposit or change branch", async () => {
    for (const branches of [[], [0, 7], [1, 7]]) {
      const w = new HDWallet();
      await expect(
        (w as any).initialize({ branches }),
        JSON.stringify(branches),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    }
  });

  it("plans the BCH change and every token change output on an address of its own", async () => {
    const w = await HDWallet.fromId(
      `hd:mainnet:divide battle bulb improve hockey favorite charge save merit fatal frog cage`,
    );
    const plan = w["planChangeAddresses"]();

    // the BCH change first, then each token output the next unused change address in turn
    expect(plan.bch).toBe(w.getChangeAddress());
    expect(plan.token()).toBe(toTokenaddr(w.getChangeAddress(1)));
    expect(plan.token()).toBe(toTokenaddr(w.getChangeAddress(2)));
    // a token operation and its send plan the BCH change on the same address
    expect(w["planChangeAddresses"]().bch).toBe(plan.bch);

    // a single-address or watch-only wallet has the one address for all of it
    const single = await RegTestWallet.newRandom();
    const singlePlan = single["planChangeAddresses"]();
    expect(singlePlan.bch).toBe(single.cashaddr);
    expect(singlePlan.token()).toBe(single.tokenaddr);
    expect(singlePlan.token()).toBe(single.tokenaddr);
    const watch = await new RegTestWatchWallet()["watchOnly"](single.cashaddr);
    expect(watch["planChangeAddresses"]().token()).toBe(single.tokenaddr);
  });

  it("seeds per-branch indices from the `indices` constructor option", async () => {
    const mnemonic =
      "divide battle bulb improve hockey favorite charge save merit fatal frog cage";
    const w = new HDWallet();
    await (w as any).initialize({
      mnemonic,
      branches: [0, 1, 7],
      indices: { 0: 5, 7: 3 },
    });

    expect(w.indices.get(0)).toBe(5);
    expect(w.indices.get(1)).toBe(0); // not specified -- defaults to 0
    expect(w.indices.get(7)).toBe(3);
  });

  it("getTokenAddressByBranch yields token-prefixed addresses for arbitrary branches", async () => {
    const mnemonic =
      "divide battle bulb improve hockey favorite charge save merit fatal frog cage";
    const w = new HDWallet();
    await (w as any).initialize({ mnemonic, branches: [0, 1, 7] });

    const plain = w.getAddressByBranch(7, 0);
    const token = w.getTokenAddressByBranch(7, 0);
    expect(token).not.toBe(plain);
    // P2PKH uses the 'q' prefix; the token-aware variant uses 'z'.
    expect(plain.startsWith("bitcoincash:q")).toBe(true);
    expect(token.startsWith("bitcoincash:z")).toBe(true);
    // Untracked branch also throws on the token-address variant.
    expect(() => w.getTokenAddressByBranch(99, 0)).toThrow(/not tracked/);
  });

  it("toDbString for a depth-4 wallet round-trips", async () => {
    const mnemonic =
      "divide battle bulb improve hockey favorite charge save merit fatal frog cage";
    const original = await HDWallet.fromId(
      `hd:mainnet:${mnemonic}:m/44'/0'/0'/0`,
    );

    const dbString = original.toDbString();
    // hd:mainnet:<mnemonic>:<derivation>:<depositIdx>:<changeIdx>
    const parts = dbString.split(":");
    expect(parts[3]).toBe("m/44'/0'/0'/0");

    const restored = await HDWallet.fromId(dbString);
    expect(restored.getDepositAddress(0)).toBe(original.getDepositAddress(0));
    expect(restored.getChangeAddress(0)).toBe(original.getChangeAddress(0));
  });

  it("end-to-end: tracks a [0, 1, 7] wallet and counts branch 7's coins", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    const w = new RegTestHDWallet();
    await (w as any).initialize({ branches: [0, 1, 7] });

    expect([...w["branches"]]).toEqual([0, 1, 7]);
    expect(w.indices.get(7)).toBe(0);

    // Fund the branch-7 address at index 0.
    await fundingWallet.send({
      cashaddr: w.getAddressByBranch(7, 0),
      value: 50_000n,
    });
    await w["waitForUpdate"]({ indices: { 7: 1 } });
    expect(w.indices.get(7)).toBe(1);

    // getUtxos and getBalance cover every tracked branch, branches 0 and 1 being empty
    const all = await w.getUtxos();
    expect(all).toHaveLength(1);
    expect(all[0].satoshis).toBe(50_000n);
    expect(all[0].address).toBe(w.getAddressByBranch(7, 0));
    expect(await w.getBalance()).toBe(50_000n);
  });

  it("end-to-end: a depth-4 wallet advances its deposit branch on receipt", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    const seedWallet = await RegTestHDWallet.newRandom();
    const w = await RegTestHDWallet.fromId(
      `hd:regtest:${seedWallet.mnemonic!}:m/44'/0'/0'/0`,
    );
    expect([...w["branches"]]).toEqual([0, 1]);

    await fundingWallet.send({
      cashaddr: w.getDepositAddress(0),
      value: 30_000n,
    });
    await w["waitForUpdate"]({ indices: { 0: 1 } });

    expect(w.indices.get(0)).toBe(1);
    expect(await w.getBalance()).toBe(30_000n);
  });

  // a wallet made without a path takes the default, BCH's m/44'/145'/0', and keeps it in its id
  it("should serialize", async () => {
    const wallet = await HDWallet.fromId(
      `hd:mainnet:divide battle bulb improve hockey favorite charge save merit fatal frog cage`,
    );
    expect(wallet.toDbString()).toBe(
      "hd:mainnet:divide battle bulb improve hockey favorite charge save merit fatal frog cage:m/44'/145'/0':0:0",
    );

    wallet.name = "testWallet";
    expect(wallet.toDbString()).toBe(
      "hd:mainnet:divide battle bulb improve hockey favorite charge save merit fatal frog cage:m/44'/145'/0':0:0",
    );

    const xPrivWallet = await HDWallet.fromId(`hd:mainnet:${expectedXprv}`);
    expect(xPrivWallet.toDbString()).toBe(
      "hd:mainnet:xprv9yHV1hFYFTfNmUpXP2S3XbBTz61AeXKRLx7Eyp4r53DiwadSoMVMJfm5fvtxBc3NFKfozcH42LM66Kb5VaxdLvGk43JWahCegx6iaEJbkB2:0:0",
    );

    const xPubWallet = await HDWallet.fromId(`hd:mainnet:${expectedXpub}`);
    expect(xPubWallet.toDbString()).toBe(
      "hd:mainnet:xpub6CGqRCnS5qDfyxtzV3y3tj8CY7qf3z3GiB2qnCUTdNkhpNxbLtobrU5ZXBVPG3rzPcBUpJAoj3K1u1jyDwKuduL71gLPm27Tckc85apgQRr:0:0",
    );

    const uninitializedWallet = new HDWallet();
    expect(() => uninitializedWallet.toDbString()).toThrowError(
      "HDWallet has no mnemonic, xPriv or xPub to serialize",
    );
  });

  it("restores an xprv, tprv or xpub walletId", async () => {
    const mnemonic =
      "divide battle bulb improve hockey favorite charge save merit fatal frog cage";
    const fromSeed = await HDWallet.fromId(
      `hd:mainnet:${mnemonic}:m/44'/0'/0'`,
    );

    const xPrivWallet = await HDWallet.fromId(`hd:mainnet:${expectedXprv}`);
    const xPrivRestored = await HDWallet.fromId(xPrivWallet.toDbString());
    expect(xPrivRestored.mnemonic).toBeUndefined();
    expect(xPrivRestored["xPriv"]).toBe(expectedXprv);
    expect(xPrivRestored.toDbString()).toBe(xPrivWallet.toDbString());
    expect(xPrivRestored.getDepositAddress(0)).toBe(
      fromSeed.getDepositAddress(0),
    );

    const xPubWallet = await HDWallet.fromId(`hd:mainnet:${expectedXpub}`);
    const xPubRestored = await HDWallet.fromId(xPubWallet.toDbString());
    expect(xPubRestored["xPriv"]).toBeUndefined();
    expect(xPubRestored.xPub).toBe(expectedXpub);
    expect(xPubRestored.toDbString()).toBe(xPubWallet.toDbString());

    const testnetSeed = await HDWallet.fromId(`hd:testnet:${mnemonic}`, {
      network: "testnet",
    });
    const tPriv = testnetSeed["xPriv"];
    expect(tPriv.startsWith("tprv")).toBe(true);
    const tPrivWallet = await HDWallet.fromId(`hd:testnet:${tPriv}`, {
      network: "testnet",
    });
    const tPrivRestored = await HDWallet.fromId(tPrivWallet.toDbString(), {
      network: "testnet",
    });
    expect(tPrivRestored.toDbString()).toBe(`hd:testnet:${tPriv}:0:0`);
    expect(tPrivRestored.getDepositAddress(0)).toBe(
      testnetSeed.getDepositAddress(0),
    );
    // an xprv id is not one of a testnet wallet's
    await expect(
      HDWallet.fromId(`hd:testnet:${expectedXprv}:0:0`, { network: "testnet" }),
    ).rejects.toThrow("does not match wallet network");
  });

  it("restores a mnemonic walletId whose first word starts like an xprv", async () => {
    // a Czech mnemonic, the only BIP39 word with "prv" at index 1
    const mnemonic =
      "zprvu abdikace abdikace abdikace abdikace abdikace abdikace abdikace abdikace abdikace abdikace adresa";
    const wallet = await HDWallet.fromId(`hd:mainnet:${mnemonic}`);
    const restored = await HDWallet.fromId(wallet.toDbString());
    expect(restored.mnemonic).toBe(mnemonic);
    expect(restored.getDepositAddress(0)).toBe(wallet.getDepositAddress(0));
  });

  it("Get next unused indices", () => {
    expect(getNextUnusedIndices(3, [])).toEqual([0, 1, 2]);
    expect(getNextUnusedIndices(3, ["", null, "", null])).toEqual([1, 3, 4]);
    expect(getNextUnusedIndices(2, ["", ""])).toEqual([2, 3]);
    expect(getNextUnusedIndices(0, [null])).toEqual([]);
  });

  it("Get next index", () => {
    expect(getNextUnusedIndex(-1, [null, null, null])).toBe(0);
    expect(getNextUnusedIndex(-1, ["", null, null])).toBe(1);
    expect(getNextUnusedIndex(-1, ["", null, ""])).toBe(1);
    expect(getNextUnusedIndex(-1, ["", "", null])).toBe(2);
    expect(getNextUnusedIndex(-1, ["", "", ""])).toBe(3);

    expect(getNextUnusedIndex(0, [null, null, null])).toBe(0);
    expect(getNextUnusedIndex(1, [null, null, null])).toBe(1);
    expect(getNextUnusedIndex(2, [null, null, null])).toBe(2);

    expect(
      getNextUnusedIndex(-1, [
        "759933dd4c6d75f097ec75158ebc04a1f89bc484fc6df0352816328fb4f533a4",
        null,
        null,
        null,
      ]),
    ).toBe(1);
  });

  it("promises", async () => {
    const result = await Promise.all([
      (async () => 1)(),
      new Promise((resolve) => resolve(2)),
    ]);
    expect(stringify(result)).toBe(stringify([1, 2]));
  });

  it("deposit indexes", async () => {
    const hdWallet = await RegTestHDWallet.newRandom();
    expect(hdWallet.indices.get(0)!).toBe(0);

    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });
    expect(hdWallet.indices.get(0)!).toBe(1);

    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(1),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 2 } });
    expect(hdWallet.indices.get(0)!).toBe(2);

    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(4),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 5 } });
    expect(hdWallet.indices.get(0)!).toBe(5);

    // beyond gap size, should not update index
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(30),
      value: 100000n,
    });
    expect(hdWallet.indices.get(0)!).toBe(5);
  });

  it("should scan beyond gap to find real deposit index", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    // Create a wallet and fund addresses 0 and 20
    // Initial scan covers 0-19, finds addr 0 used (depositIndex=1)
    // Gap from index 1 to end of scan (19) is 19 < 20, so scanner extends
    // Next batch includes addr 20, finds it used (depositIndex=21)
    const seedWallet = await RegTestHDWallet.newRandom();
    const addr0 = seedWallet.getDepositAddress(0);
    const addr20 = seedWallet.getDepositAddress(20);

    await fundingWallet.send([
      { cashaddr: addr0, value: 10000n },
      { cashaddr: addr20, value: 10000n },
    ]);
    // Wait for seedWallet to see both transactions via electrum
    await seedWallet["waitForUpdate"]({ indices: { 0: 21 } });

    // Restore wallet from same seed, starting from index 0
    const restoredWallet = await RegTestHDWallet.fromId(
      `hd:regtest:${seedWallet.mnemonic!}:${seedWallet.derivation}`,
    );
    await restoredWallet["watchPromise"];

    expect(restoredWallet.indices.get(0)!).toBe(21);
  });

  it("changeIndex updates when spending", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const hdWallet = await RegTestHDWallet.newRandom();
    const bob = await RegTestWallet.newRandom();

    expect(hdWallet.indices.get(0)!).toBe(0);
    expect(hdWallet.indices.get(1)!).toBe(0);

    // fund deposit address 0
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });
    expect(hdWallet.indices.get(0)!).toBe(1);
    expect(hdWallet.indices.get(1)!).toBe(0);

    // spend, which creates change on change address 0
    await hdWallet.send({
      cashaddr: bob.getDepositAddress(),
      value: 50000n,
    });
    expect(hdWallet.indices.get(1)!).toBe(1);

    // fund and spend again, change goes to change address 1
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 2 } });
    await hdWallet.send({
      cashaddr: bob.getDepositAddress(),
      value: 50000n,
    });
    expect(hdWallet.indices.get(1)!).toBe(2);

    // Restore wallet from same seed and verify depositIndex is correct
    const restoredWallet = await RegTestHDWallet.fromId(
      `hd:regtest:${hdWallet.mnemonic!}:${hdWallet.derivation}`,
    );
    await restoredWallet["watchPromise"];

    expect(restoredWallet.indices.get(0)!).toBe(hdWallet.indices.get(0)!);
    expect(restoredWallet.indices.get(1)!).toBe(hdWallet.indices.get(1)!);
  });

  it("hasAddress should recognize wallet addresses", async () => {
    const hdWallet = await RegTestHDWallet.newRandom();

    const deposit0 = hdWallet.getDepositAddress(0);
    const deposit1 = hdWallet.getDepositAddress(1);
    const change0 = hdWallet.getChangeAddress(0);

    expect(hdWallet.hasAddress(deposit0)).toBe(true);
    expect(hdWallet.hasAddress(deposit1)).toBe(true);
    expect(hdWallet.hasAddress(change0)).toBe(true);
    expect(
      hdWallet.hasAddress("bchreg:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9d5dxv4"),
    ).toBe(false);
  });

  it("Should send funds from an HDWallet", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    const hdWallet = await RegTestHDWallet.newRandom();
    expect(await hdWallet.getBalance()).toBe(0n);

    const depositAddress = hdWallet.getDepositAddress();
    await fundingWallet.send({
      cashaddr: depositAddress,
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });

    expect(await hdWallet.getBalance()).toBe(100000n);

    const depositAddress2 = hdWallet.getDepositAddress();
    expect(depositAddress).not.toBe(depositAddress2);

    // send more funds to new deposit address
    await fundingWallet.send({
      cashaddr: depositAddress2,
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 2 } });

    expect(await hdWallet.getBalance()).toBe(200000n);

    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getDepositAddress(0)}`,
        )
      ).getBalance(),
    ).toBe(100000n);
    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getDepositAddress(1)}`,
        )
      ).getBalance(),
    ).toBe(100000n);
    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getDepositAddress(2)}`,
        )
      ).getBalance(),
    ).toBe(0n);

    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getChangeAddress(0)}`,
        )
      ).getBalance(),
    ).toBe(0n);

    const bob = await RegTestWallet.newRandom();

    await hdWallet.send({
      cashaddr: bob.getDepositAddress(),
      value: 150000n,
    });

    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getDepositAddress(0)}`,
        )
      ).getBalance(),
    ).toBe(0n);
    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getDepositAddress(1)}`,
        )
      ).getBalance(),
    ).toBe(0n);
    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getDepositAddress(2)}`,
        )
      ).getBalance(),
    ).toBe(0n);

    expect(
      await (
        await RegTestWallet.fromId(
          `watch:regtest:${hdWallet.getChangeAddress(0)}`,
        )
      ).getBalance(),
    ).toBeGreaterThan(50000n - 1000n);

    expect(hdWallet.getChangeAddress()).not.toBe(hdWallet.getChangeAddress(0));
    expect(hdWallet.getChangeAddress()).toBe(hdWallet.getChangeAddress(1));

    expect(hdWallet.indices.get(0)!).toBe(2);
    expect(hdWallet.indices.get(1)!).toBe(1);

    expect(await bob.getBalance()).toBe(150000n);

    expect(await hdWallet.getBalance()).toBe(49639n); // minus fees

    expect(await hdWallet.getMaxAmountToSend()).toBe(49443n);
    const charlie = await RegTestWallet.newRandom();
    await hdWallet.sendMax(charlie.cashaddr);

    // Wait for HD wallet to process the spent notification
    while ((await hdWallet.getBalance()) > 0n)
      await new Promise((r) => setTimeout(r, 50));

    expect(await charlie.getBalance()).toBe(49443n);
    expect(await hdWallet.getBalance()).toBe(0n);
  });

  it("WalletCache persistence, addresses", async () => {
    const indexedDbCacheValue = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;

    const hdWallet = await RegTestHDWallet.newRandom();

    // get some addresses to populate cache
    hdWallet.getDepositAddress(0);
    hdWallet.getDepositAddress(100);

    hdWallet.getChangeAddress(0);
    hdWallet.getChangeAddress(100);

    // persist cache
    await hdWallet.walletCache.persist(true);

    // check cache data is there in other instance
    const otherWallet = await RegTestHDWallet.fromId(hdWallet.toDbString());
    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(0))
        ?.privateKey instanceof Uint8Array,
    ).toBe(true);
    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(0))
        ?.publicKey instanceof Uint8Array,
    ).toBe(true);
    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(0))
        ?.publicKeyHash instanceof Uint8Array,
    ).toBe(true);

    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(0)),
    ).toBeDefined();
    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(99)),
    ).not.toBeDefined();
    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(100)),
    ).toBeDefined();

    expect(
      otherWallet.walletCache.get(hdWallet.getChangeAddress(0)),
    ).toBeDefined();
    expect(
      otherWallet.walletCache.get(hdWallet.getChangeAddress(99)),
    ).not.toBeDefined();
    expect(
      otherWallet.walletCache.get(hdWallet.getChangeAddress(100)),
    ).toBeDefined();

    Config.UseIndexedDBCache = indexedDbCacheValue;
  });

  it("WalletCache persistence, status and utxo", async () => {
    const indexedDbCacheValue = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;

    const hdWallet = await RegTestHDWallet.newRandom();

    // get some addresses to populate cache
    hdWallet.getDepositAddress(0);
    expect(
      hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.status,
    ).toBeNull();

    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });

    expect(
      hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.status,
    ).not.toBeNull();
    expect(
      hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.utxos.length,
    ).toBe(1);

    // persist cache
    await hdWallet.walletCache.persist(true);

    // check cache data is there in other instance
    const otherWallet = await RegTestHDWallet.fromId(hdWallet.toDbString());
    await otherWallet["watchPromise"]; // ensure any async init is done
    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(0))?.status,
    ).not.toBeNull();
    expect(
      hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.utxos.length,
    ).toBe(1);
    expect(
      stringify(hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.utxos),
    ).toBe(
      stringify(
        otherWallet.walletCache.get(hdWallet.getDepositAddress(0))?.utxos,
      ),
    );

    Config.UseIndexedDBCache = indexedDbCacheValue;
  });

  it("WalletCache persistence, rawHistory", async () => {
    const indexedDbCacheValue = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;

    const hdWallet = await RegTestHDWallet.newRandom();

    // get deposit address to populate cache
    hdWallet.getDepositAddress(0);
    expect(
      hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.rawHistory,
    ).toEqual([]);

    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });

    // rawHistory should now have one entry
    expect(
      hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.rawHistory
        .length,
    ).toBe(1);

    // persist cache
    await hdWallet.walletCache.persist(true);

    // check cache data is there in other instance
    const otherWallet = await RegTestHDWallet.fromId(hdWallet.toDbString());
    await otherWallet["watchPromise"];
    expect(
      otherWallet.walletCache.get(hdWallet.getDepositAddress(0))?.rawHistory
        .length,
    ).toBe(1);
    expect(
      stringify(
        hdWallet.walletCache.get(hdWallet.getDepositAddress(0))?.rawHistory,
      ),
    ).toBe(
      stringify(
        otherWallet.walletCache.get(hdWallet.getDepositAddress(0))?.rawHistory,
      ),
    );

    Config.UseIndexedDBCache = indexedDbCacheValue;
  });

  it("getRawHistory uses cached data", async () => {
    const hdWallet = await RegTestHDWallet.newRandom();

    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    // Send to multiple deposit addresses
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });

    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(1),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 2 } });

    // Check branch-0 per-address raw-history arrays are populated.
    expect(hdWallet.rawHistory.get(0)![0].length).toBe(1);
    expect(hdWallet.rawHistory.get(0)![1].length).toBe(1);

    // getRawHistory should return deduplicated history from cache
    const rawHistory = await hdWallet.getRawHistory();
    expect(rawHistory.length).toBe(2);

    // Verify history items have expected structure
    expect(rawHistory[0]).toHaveProperty("tx_hash");
    expect(rawHistory[0]).toHaveProperty("height");
  });

  it("getHistory works with cached rawHistory", async () => {
    const hdWallet = await RegTestHDWallet.newRandom();

    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });

    const history = await hdWallet.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].valueChange).toBe(100000);
  });

  it("incremental history fetching with lastConfirmedHeight", async () => {
    const indexedDbCacheValue = Config.UseIndexedDBCache;
    Config.UseIndexedDBCache = true;

    const hdWallet = await RegTestHDWallet.newRandom();

    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    // First transaction
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 50000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });

    // Check rawHistory is populated
    const cacheEntry1 = hdWallet.walletCache.get(hdWallet.getDepositAddress(0));
    expect(cacheEntry1?.rawHistory.length).toBe(1);
    // lastConfirmedHeight may be 0 if tx is unconfirmed
    expect(cacheEntry1?.lastConfirmedHeight).toBeGreaterThanOrEqual(0);

    // Second transaction to same address
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 60000n,
    });
    while (hdWallet.rawHistory.get(0)![0].length < 2)
      await new Promise((r) => setTimeout(r, 50));

    // Check history accumulated correctly
    const cacheEntry2 = hdWallet.walletCache.get(hdWallet.getDepositAddress(0));
    expect(cacheEntry2?.rawHistory.length).toBe(2);

    // Verify getRawHistory returns both transactions
    const rawHistory = await hdWallet.getRawHistory();
    expect(rawHistory.length).toBe(2);

    // Persist and reload - cache should be preserved
    await hdWallet.walletCache.persist(true);
    const otherWallet = await RegTestHDWallet.fromId(hdWallet.toDbString());
    await otherWallet["watchPromise"];

    const reloadedEntry = otherWallet.walletCache.get(
      hdWallet.getDepositAddress(0),
    );
    expect(reloadedEntry?.lastConfirmedHeight).toBe(
      cacheEntry2?.lastConfirmedHeight,
    );
    expect(reloadedEntry?.rawHistory.length).toBe(2);

    Config.UseIndexedDBCache = indexedDbCacheValue;
  });

  it("watchWallet registers and removes callbacks", async () => {
    const hdWallet = await RegTestHDWallet.newRandom();

    const cancel = await hdWallet["watchStatus"](() => {});

    // Verify callback was registered
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(1);

    // Cancel
    await cancel();

    // Verify callback was removed
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(0);
  });

  it("waitForUpdate resolves via timeout when depositIndex target is not reached", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const hdWallet = await RegTestHDWallet.newRandom();
    expect(hdWallet.indices.get(0)!).toBe(0);

    // No transaction sent - idle timer should resolve without hanging
    await hdWallet["waitForUpdate"]({ indices: { 0: 1 } });

    // depositIndex is still 0 because no funds arrived
    expect(hdWallet.indices.get(0)!).toBe(0);

    // No leftover watchers
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(0);

    // Now send a real transaction - waitForUpdate should resolve once index advances
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await hdWallet["waitForUpdate"]();

    expect(hdWallet.indices.get(0)!).toBe(1);
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(0);
  });

  it("watchWallet supports multiple watchers", async () => {
    const hdWallet = await RegTestHDWallet.newRandom();

    const cancel1 = await hdWallet["watchStatus"](() => {});
    const cancel2 = await hdWallet["watchStatus"](() => {});

    // Verify both callbacks registered
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(2);

    // Cancel one watcher
    await cancel1();
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(1);

    await cancel2();
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(0);
  });

  it("watchUtxos sets up callback correctly", async () => {
    const hdWallet = await RegTestHDWallet.newRandom();

    const cancel = await hdWallet.watchUtxos(() => {});

    // Verify callback was registered via watchStatus
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(1);

    await cancel();
    expect((hdWallet as any).walletWatchCallbacks.length).toBe(0);
  });

  it("Cashtokens integration test", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const alice = await RegTestHDWallet.newRandom();
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(),
      value: 1000000n,
    });
    await alice["waitForUpdate"]({ indices: { 0: 1 } });

    const genesisResponse = await alice.tokenGenesis({
      cashaddr: alice.getDepositAddress(1),
      nft: {
        capability: NFTCapability.minting,
        commitment: "abcd",
      },
      amount: 1000n,
    });

    const category = genesisResponse.categories![0];

    // mint 2 NFTs, amount reducing
    const response = await alice.tokenMint([
      new TokenMintRequest({
        category: category,
        cashaddr: alice.getDepositAddress(2),
        nft: {
          capability: NFTCapability.none,
          commitment: "",
        },
      }),
      new TokenMintRequest({
        category: category,
        cashaddr: alice.getDepositAddress(3),
        nft: {
          capability: NFTCapability.mutable,
          commitment: "00",
        },
      }),
    ]);

    const newTokenUtxos = await getTokenUtxos(alice, category);
    expect(newTokenUtxos.length).toBe(3);
    expect(category).toEqual(response.categories![0]);

    const bob = await RegTestWallet.newRandom();
    await alice.send([
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: NFTCapability.minting,
          commitment: "abcd",
        },
        amount: 1000n,
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: NFTCapability.none,
          commitment: "",
        },
      }),
      new TokenSendRequest({
        cashaddr: bob.cashaddr!,
        category: category,
        nft: {
          capability: NFTCapability.mutable,
          commitment: "00",
        },
      }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect((await getTokenUtxos(alice, category)).length).toBe(0);
    const bobTokenUtxos = await getTokenUtxos(bob, category);
    expect(bobTokenUtxos.length).toBe(3);
    expect(category).toEqual(response.categories![0]);
  });

  const outputAddresses = (wallet: HDWallet, transactionHex: string) =>
    assertSuccess(decodeTransaction(hexToBin(transactionHex))).outputs.map(
      (output) => ({
        address: assertSuccess(
          lockingBytecodeToCashAddress({
            bytecode: output.lockingBytecode,
            prefix: wallet.networkPrefix,
            tokenSupport: true,
          }),
        ).address,
        token: output.token,
      }),
    );

  it("tokenMint sends the minting NFT to a fresh token change address", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const alice = await RegTestHDWallet.newRandom();
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(),
      value: 100000n,
    });
    await alice["waitForUpdate"]({ indices: { 0: 1 } });

    const genesisResponse = await alice.tokenGenesis({
      nft: { capability: NFTCapability.minting, commitment: "" },
    });
    const category = genesisResponse.categories![0];
    const [baton] = await getTokenUtxos(alice, category);

    const bob = await RegTestWallet.newRandom();
    const response = await alice.tokenMint(
      {
        category,
        cashaddr: bob.tokenaddr!,
        nft: { capability: NFTCapability.none, commitment: "01" },
      },
      { broadcast: false },
    );

    const batonOutputs = outputAddresses(alice, response.transaction!).filter(
      (output) => output.token?.nft?.capability === "minting",
    );
    expect(batonOutputs.length).toBe(1);
    expect(batonOutputs[0].address).not.toBe(toTokenaddr(baton.address));
    // the genesis took change address 0; the mint's BCH change gets 1 and the minting NFT the next
    expect(batonOutputs[0].address).toBe(
      toTokenaddr(alice.getChangeAddress(2)),
    );
    const bchChange = outputAddresses(alice, response.transaction!).filter(
      (output) =>
        !output.token &&
        output.address === toTokenaddr(alice.getChangeAddress(1)),
    );
    expect(bchChange.length).toBe(1);
  });

  it("tokenMint and tokenGenesis give each output defaulting to the wallet its own address", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const alice = await RegTestHDWallet.newRandom();
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(),
      value: 100000n,
    });
    await alice["waitForUpdate"]({ indices: { 0: 1 } });

    const genesisResponse = await alice.tokenGenesis({
      nft: { capability: NFTCapability.minting, commitment: "" },
    });
    const category = genesisResponse.categories![0];

    const bob = await RegTestWallet.newRandom();
    const mintResponse = await alice.tokenMint(
      [
        { category, nft: { capability: NFTCapability.none, commitment: "01" } },
        {
          category,
          cashaddr: bob.tokenaddr!,
          nft: { capability: NFTCapability.none, commitment: "02" },
        },
        { category, nft: { capability: NFTCapability.none, commitment: "03" } },
        { category, nft: { capability: NFTCapability.none, commitment: "04" } },
      ],
      { broadcast: false },
    );
    const minted = outputAddresses(alice, mintResponse.transaction!).filter(
      (output) => output.token?.nft?.capability === "none",
    );
    expect(minted.map((output) => output.address)).toEqual([
      alice.getTokenDepositAddress(2),
      bob.tokenaddr,
      alice.getTokenDepositAddress(3),
      alice.getTokenDepositAddress(4),
    ]);

    // each genesis spends a vout=0 input of its own
    for (const index of [2, 3]) {
      await fundingWallet.send({
        cashaddr: alice.getDepositAddress(index),
        value: 100000n,
      });
      await alice["waitForUpdate"]({ indices: { 0: index + 1 } });
    }
    const multiGenesis = await alice.tokenGenesis(
      [{ amount: 10n }, { amount: 20n }],
      [],
      { broadcast: false },
    );
    const created = outputAddresses(alice, multiGenesis.transaction!).filter(
      (output) => output.token,
    );
    expect(created.map((output) => output.address)).toEqual([
      alice.getTokenDepositAddress(4),
      alice.getTokenDepositAddress(5),
    ]);
  });

  it("gives the BCH change and every token change output an address of its own", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const alice = await RegTestHDWallet.newRandom();
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(),
      value: 100000n,
    });
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(1),
      value: 100000n,
    });
    await alice["waitForUpdate"]({ indices: { 0: 2 } });

    const genesis = await alice.tokenGenesis([
      { amount: 100n },
      { amount: 200n },
    ]);
    const [catA, catB] = genesis.categories!;

    const bob = await RegTestWallet.newRandom();
    const changeAddresses = alice["getChangeAddresses"](3);
    const response = await alice.send(
      [
        new TokenSendRequest({
          cashaddr: bob.tokenaddr!,
          category: catA!,
          amount: 10n,
        }),
        new TokenSendRequest({
          cashaddr: bob.tokenaddr!,
          category: catB!,
          amount: 20n,
        }),
      ],
      { broadcast: false },
    );

    const outputs = outputAddresses(alice, response.transaction!);
    const change = outputs.filter((output) => output.address !== bob.tokenaddr);
    expect(
      change.map((output) => [output.address, output.token?.amount]),
    ).toEqual(
      expect.arrayContaining([
        [toTokenaddr(changeAddresses[0]!), undefined],
        [toTokenaddr(changeAddresses[1]!), 90n],
        [toTokenaddr(changeAddresses[2]!), 180n],
      ]),
    );
    expect(change.length).toBe(3);
    expect(new Set(change.map((output) => output.address)).size).toBe(3);
  });

  it("returns each coin a sendMax sweeps on a change address of its own", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const alice = await RegTestHDWallet.newRandom();
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(),
      value: 100000n,
    });
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(1),
      value: 100000n,
    });
    await alice["waitForUpdate"]({ indices: { 0: 2 } });
    const genesis = await alice.tokenGenesis([
      { amount: 100n, value: 20000n },
      { amount: 200n, value: 20000n },
    ]);

    const bob = await RegTestWallet.newRandom();
    const [, ...tokenChange] = alice["getChangeAddresses"](3);
    const response = await alice.sendMax(bob.cashaddr!, {
      sweepTokenSatoshis: true,
      broadcast: false,
    });

    const returns = outputAddresses(alice, response.transaction!).filter(
      (output) => output.token,
    );
    expect(returns.map((output) => output.token!.amount)).toEqual([100n, 200n]);
    expect(returns.map((output) => output.address)).toEqual(
      tokenChange.map((address) => toTokenaddr(address)),
    );
    expect(returns.map((output) => output.token!.category)).toEqual(
      genesis.categories!.map((category) => hexToBin(category)),
    );
  });

  it("a fungible token send spends only the coins its amount needs", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const alice = await RegTestHDWallet.newRandom();
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(),
      value: 100000n,
    });
    await alice["waitForUpdate"]({ indices: { 0: 1 } });

    const genesisResponse = await alice.tokenGenesis({ amount: 550n });
    const category = genesisResponse.categories![0];

    // ten coins of 10 to 100 tokens, each on an address of its own
    await alice.send(
      Array.from(
        { length: 10 },
        (_, i) =>
          new TokenSendRequest({
            cashaddr: alice.getTokenDepositAddress(2 + i),
            category,
            amount: BigInt(10 * (i + 1)),
          }),
      ),
    );
    const coins = await getTokenUtxos(alice, category);
    expect(coins.length).toBe(10);

    const bob = await RegTestWallet.newRandom();
    // the BCH change and the token change each on an unused change address of its own
    const [bchChangeAddress, nextChangeAddress] =
      alice["getChangeAddresses"](2);
    const tokenChangeAddress = toTokenaddr(nextChangeAddress!);
    const response = await alice.send(
      new TokenSendRequest({
        cashaddr: bob.tokenaddr!,
        category,
        amount: 180n,
      }),
    );

    // the two largest coins, so only their two addresses are linked (mainnet-js#246)
    const tx = assertSuccess(
      decodeTransaction(hexToBin(response.transaction!)),
    );
    const spentCoins = coins.filter((coin) =>
      tx.inputs.some(
        (input) =>
          binToHex(input.outpointTransactionHash) === coin.txid &&
          input.outpointIndex === coin.vout,
      ),
    );
    expect(spentCoins.map((coin) => coin.address).sort()).toEqual(
      [alice.getDepositAddress(10), alice.getDepositAddress(11)].sort(),
    );
    expect(
      spentCoins
        .map((coin) => coin.token!.amount)
        .sort((a, b) => Number(a - b)),
    ).toEqual([90n, 100n]);
    // and no implicit burn: the 10 tokens over what was sent come back as change
    expect(
      outputAddresses(alice, response.transaction!)
        .filter((output) => output.token)
        .map((output) => ({
          address: output.address,
          amount: output.token!.amount,
        })),
    ).toEqual([
      { address: bob.tokenaddr, amount: 180n },
      { address: tokenChangeAddress, amount: 10n },
    ]);
    expect(
      outputAddresses(alice, response.transaction!).filter(
        (output) =>
          !output.token && output.address === toTokenaddr(bchChangeAddress!),
      ).length,
    ).toBe(1);

    expect((await getTokenUtxos(alice, category)).length).toBe(9);
    expect(await getTokenBalance(alice, category)).toBe(370n);
    expect(await getTokenBalance(bob, category)).toBe(180n);
  });

  test("Test enforcing token addresses", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const alice = await RegTestHDWallet.newRandom();
    await fundingWallet.send({
      cashaddr: alice.getDepositAddress(),
      value: 1000000n,
    });
    await alice["waitForUpdate"]({ indices: { 0: 1 } });

    const genesisResponse = await alice.tokenGenesis({
      amount: 100n,
    });
    const category = genesisResponse.categories![0];

    const previousValue = Config.EnforceCashTokenReceiptAddresses;

    const wrap = (addr: string) => {
      return new Promise((resolve) => {
        resolve(new TokenSendRequest({ cashaddr: addr, category, amount: 1n }));
      });
    };

    Config.EnforceCashTokenReceiptAddresses = false;
    await expect(wrap(alice.getDepositAddress())).resolves.not.toThrow();
    await expect(wrap(alice.getTokenDepositAddress())).resolves.not.toThrow();

    await expect(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.getDepositAddress(),
          category: category,
          amount: 1n,
        }),
      ),
    ).resolves.not.toThrow();

    await expect(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.getTokenDepositAddress(),
          category: category,
          amount: 2n,
        }),
      ),
    ).resolves.not.toThrow();

    Config.EnforceCashTokenReceiptAddresses = true;
    await expect(wrap(alice.getDepositAddress())).rejects.toThrow();
    await expect(wrap(alice.getTokenDepositAddress())).resolves.not.toThrow();

    await expect(
      (async () =>
        await alice.send(
          new TokenSendRequest({
            cashaddr: alice.getDepositAddress(),
            category: category,
            amount: 1n,
          }),
        ))(),
    ).rejects.toThrow();

    await expect(
      alice.send(
        new TokenSendRequest({
          cashaddr: alice.getTokenDepositAddress(),
          category: category,
          amount: 2n,
        }),
      ),
    ).resolves.not.toThrow();

    Config.EnforceCashTokenReceiptAddresses = previousValue;
  });

  it("watchUtxos takes the coins at setup as its baseline and reports each new coin once", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const hdWallet = await RegTestHDWallet.newRandom();

    // coins at deposit addresses 0 and 1 before the watch
    const fund0 = await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(0),
      value: 100000n,
    });
    await mine({ cashaddr: fundingWallet.cashaddr!, blocks: 1 });
    await delay(1000);
    const fund1 = await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(1),
      value: 100000n,
    });
    await mine({ cashaddr: fundingWallet.cashaddr!, blocks: 1 });
    await delay(1000);
    expect(hdWallet.indices.get(0)!).toBe(2);

    const changes: { utxos: Utxo[]; added: Utxo[]; removed: Utxo[] }[] = [];
    const cancelWatch = await hdWallet.watchUtxos((change) => {
      changes.push(change);
    });
    await delay(1000);
    expect(changes).toHaveLength(1);
    expect(changes[0].utxos.map((utxo) => utxo.txid).sort()).toEqual(
      [fund0.txId, fund1.txId].sort(),
    );
    expect(changes[0].added).toEqual([]);

    const fund2 = await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(),
      value: 50000n,
    });
    // its confirmation does not report it again
    await mine({ cashaddr: fundingWallet.cashaddr!, blocks: 1 });
    await delay(2000);
    await cancelWatch();

    const added = changes.flatMap((change) => change.added);
    expect(added.map((utxo) => utxo.txid)).toEqual([fund2.txId]);
    expect(changes.flatMap((change) => change.removed)).toEqual([]);
  });

  it("gap is maintained when addresses near the edge are used", async () => {
    const fundingWallet = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );
    const hdWallet = await RegTestHDWallet.newRandom();
    await hdWallet["watchPromise"];

    // Initially: depositIndex=0, watched addresses 0..(GAP_SIZE-1)
    expect(hdWallet.indices.get(0)!).toBe(0);
    const initialWatched = (hdWallet as any)["statuses"].get(0)!.length;
    expect(initialWatched).toBe(GAP_SIZE);

    // Fund an address near the edge of the gap
    const edgeIndex = GAP_SIZE - 2;
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(edgeIndex),
      value: 10000n,
    });

    // Wait for the subscription callback to fire and gap extension to complete
    await hdWallet["waitForUpdate"]({ indices: { 0: edgeIndex + 1 } });
    await delay(1000);

    // depositIndex should have advanced
    expect(hdWallet.indices.get(0)!).toBe(edgeIndex + 1);

    // The watched range should have extended to maintain the gap
    const newWatched = (hdWallet as any)["statuses"].get(0)!.length;
    expect(newWatched).toBeGreaterThanOrEqual(
      hdWallet.indices.get(0)! + GAP_SIZE,
    );

    // Verify the new addresses are actually subscribed (watchCancels populated)
    const watchCancels = (hdWallet as any)["watchCancels"].get(0)!;
    for (let i = initialWatched; i < newWatched; i++) {
      expect(watchCancels[i]).toBeDefined();
    }

    // Fund an address in the newly extended range to prove it's being watched
    const newEdge = newWatched - 2;
    await fundingWallet.send({
      cashaddr: hdWallet.getDepositAddress(newEdge),
      value: 10000n,
    });
    await hdWallet["waitForUpdate"]({ indices: { 0: newEdge + 1 } });
    await delay(1000);

    expect(hdWallet.indices.get(0)!).toBe(newEdge + 1);

    // Gap should still be maintained after the second extension
    const finalWatched = (hdWallet as any)["statuses"].get(0)!.length;
    expect(finalWatched).toBeGreaterThanOrEqual(
      hdWallet.indices.get(0)! + GAP_SIZE,
    );
  });
});
