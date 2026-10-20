import { disconnectProviders, initProviders } from "#test/providers.js";
import { NFTCapability } from "../interface.js";
import { WatchOnlyError } from "./errors.js";
import { RegTestHDWallet } from "./HDWallet.js";
import { TokenBurnRequest, TokenMintRequest } from "./model.js";
import { RegTestWatchWallet } from "./Watch.js";
import { RegTestWallet, Wallet } from "./Wif.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe(`Test creation of wallet from walletId`, () => {
  test("Get a regtest wallet from string id", async () => {
    const ADDRESS = "bchreg:qpttdv3qg2usm4nm7talhxhl05mlhms3ys43u76rn0";
    const ADDRESS_TOKEN = "bchreg:zpttdv3qg2usm4nm7talhxhl05mlhms3ysjm0q59vu";

    let w = await RegTestWallet.fromId(
      "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
    );

    expect(w.cashaddr!.startsWith("bchreg:")).toBeTruthy();
    expect(w.cashaddr!).toBe(ADDRESS);
    expect(w.cashaddr!).toBe(ADDRESS);
    expect(w.tokenaddr!).toBe(ADDRESS_TOKEN);
    let w2 = await RegTestWallet.fromId(`watch:regtest:${w.cashaddr!}`);

    expect(w2.cashaddr!).toBe(ADDRESS);
    expect(w2.cashaddr!).toBe(ADDRESS);
    expect(w2.tokenaddr!).toBe(ADDRESS_TOKEN);

    let w3 = await RegTestWallet.fromId(`watch:regtest:${ADDRESS_TOKEN}`);
    expect(w3.cashaddr!).toBe(ADDRESS);
    expect(w3.cashaddr!).toBe(ADDRESS);
    expect(w3.tokenaddr!).toBe(ADDRESS_TOKEN);
  });

  test("Get create a p2sh32 watch address", async () => {
    const ADDRESS =
      "bitcoincash:pvykylj7uk385669fjse37r2eknx35ngaalx805q2hul62lmx2fq2v5dx6g8w";

    let w = await Wallet.fromId(
      `watch:mainnet:bitcoincash:pvykylj7uk385669fjse37r2eknx35ngaalx805q2hul62lmx2fq2v5dx6g8w`,
    );

    expect(w.cashaddr!.startsWith("bitcoincash:")).toBeTruthy();
    expect(w.cashaddr!).toBe(ADDRESS);
  });

  test("Get create a p2sh watch address", async () => {
    const ADDRESS = "bitcoincash:pzvts0uztwg32yvrx7xz9lp572dgnt20sy0dj993vx";

    let w = await Wallet.fromId(
      `watch:mainnet:bitcoincash:pzvts0uztwg32yvrx7xz9lp572dgnt20sy0dj993vx`,
    );

    expect(w.cashaddr!.startsWith("bitcoincash:")).toBeTruthy();
    expect(w.cashaddr!).toBe(ADDRESS);
  });
});

describe("a watch-only wallet refuses to spend before building", () => {
  // a funded wallet's coins, watched three ways: by address, as a Wallet from a watch id, by xpub
  const watchers = async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const owner = await RegTestWallet.newRandom();
    const hdOwner = await RegTestHDWallet.newRandom();
    await alice.send([
      { cashaddr: owner.cashaddr, value: 50_000n },
      { cashaddr: hdOwner.getDepositAddress(), value: 50_000n },
    ]);
    const minting = { capability: NFTCapability.minting, commitment: "" };
    const category = (await owner.tokenGenesis({ amount: 10n, nft: minting }))
      .categories![0];
    const wallets = [
      await new RegTestWatchWallet()["watchOnly"](owner.cashaddr),
      await RegTestWallet.fromId(`watch:regtest:${owner.cashaddr}`),
      await RegTestHDWallet.fromId(`hd:regtest:${hdOwner.xPub}`),
    ];
    return { owner, hdOwner, wallets, category, minting };
  };

  test("send, sendMax and the token operations throw WatchOnlyError", async () => {
    const { owner, hdOwner, wallets, category, minting } = await watchers();
    const broadcasts = vi.spyOn(wallets[0].provider, "sendRawTransaction");
    try {
      for (const wallet of wallets) {
        expect(await wallet.getBalance()).toBeGreaterThan(0n);
        const spends = [
          () => wallet.send({ cashaddr: owner.cashaddr, value: 1000n }),
          () => wallet.sendMax(owner.cashaddr),
          () => wallet.tokenGenesis({ amount: 1n }),
        ];
        if (!(wallet instanceof RegTestHDWallet)) {
          spends.push(
            () =>
              wallet.tokenMint(
                new TokenMintRequest({
                  category,
                  nft: { capability: NFTCapability.none, commitment: "01" },
                }),
              ),
            () =>
              wallet.tokenBurn(
                new TokenBurnRequest({ category, nft: minting, amount: 1n }),
              ),
          );
        }
        for (const spend of spends) {
          const error = await spend().catch((e: unknown) => e);
          expect(error).toBeInstanceOf(WatchOnlyError);
          expect((error as WatchOnlyError).name).toBe("WatchOnlyError");
        }
        // what a send would cost is still known
        expect(await wallet.getMaxAmountToSend()).toBeGreaterThan(0n);
      }
      expect(broadcasts).not.toHaveBeenCalled();
    } finally {
      broadcasts.mockRestore();
      for (const wallet of [owner, hdOwner, ...wallets]) await wallet.stop();
    }
  });
});
