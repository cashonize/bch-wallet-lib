import {
  binToHex,
  encodeBase58AddressFormat,
  encodePrivateKeyWif,
  hexToBin,
  utf8ToBin,
} from "@bitauth/libauth";
import { bchParam } from "../chain.js";
import { DUST_UTXO_THRESHOLD as DUST } from "../constant.js";
import { mine } from "#test/mine.js";
import { disconnectProviders, initProviders } from "#test/providers.js";
import { BroadcastRejectedError } from "../network/errors.js";
import { ElectrumRawTransaction } from "../network/interface.js";
import { delay } from "../util/delay.js";
import { convert } from "../util/index.js";
import { CancelFn } from "./interface.js";
import {
  OpReturnData,
  SendResponse,
  TokenSendRequest,
  toUtxoId,
} from "./model.js";
import { HDWallet } from "./HDWallet.js";
import { WatchWallet } from "./Watch.js";
import { RegTestWallet, TestNetWallet, Wallet, WifWallet } from "./Wif.js";
import { liveTests } from "#test/live.js";

beforeAll(async () => {
  await initProviders();
});
afterAll(async () => {
  await disconnectProviders();
});

describe(`Test creation of wallet from walletId`, () => {
  test("Get a regtest wallet from string id", async () => {
    let w = await RegTestWallet.fromId(
      "wif:regtest:cQAurrWpGpAtvKcGWvTYFpiTickpTUa3YzXkXpbqD342pscjbCxH",
    );
    expect(w.cashaddr!.startsWith("bchreg:")).toBeTruthy();
    expect(w.publicKey!.length).toBe(65);
    expect(w.publicKeyCompressed!.length).toBe(33);
    expect(w.privateKey!.length).toBe(32);
    expect(w.publicKeyHash!.length).toBe(20);
    expect(w.privateKeyWif !== "undefined").toBeTruthy();
  });

  test("hasAddress should recognize wallet address", async () => {
    let w = await RegTestWallet.fromId(
      "wif:regtest:cQAurrWpGpAtvKcGWvTYFpiTickpTUa3YzXkXpbqD342pscjbCxH",
    );
    expect(w.hasAddress(w.getDepositAddress())).toBe(true);
    expect(
      w.hasAddress("bchreg:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9d5dxv4"),
    ).toBe(false);
  });

  test("Should get a new random wallet", async () => {
    let w = await RegTestWallet.newRandom();
    expect(w.cashaddr!.startsWith("bchreg:")).toBeTruthy();
    expect(w.publicKey!.length).toBe(65);
    expect(w.publicKeyCompressed!.length).toBe(33);
    expect(w.privateKey!.length).toBe(32);
    expect(w.publicKeyHash!.length).toBe(20);
    expect(w.privateKeyWif !== "undefined").toBeTruthy();
  });

  test("Should get a regtest wallet from wif id string", async () => {
    let w = await RegTestWallet.fromId(process.env.ALICE_ID!);
    expect(w.cashaddr!.startsWith("bchreg:")).toBeTruthy();
    expect(w.publicKey!.length).toBe(65);
    expect(w.publicKeyCompressed!.length).toBe(33);
    expect(w.privateKey!.length).toBe(32);
    expect(w.publicKeyHash!.length).toBe(20);
    expect(w.privateKeyWif !== "undefined").toBeTruthy();
  });

  test("Should get a regtest wallet from seed id string", async () => {
    let w = await RegTestWallet.fromId(process.env.BOB_ID!);
    expect(w.cashaddr!.startsWith("bchreg:")).toBeTruthy();
    expect(w.publicKey!.length).toBe(65);
    expect(w.publicKeyCompressed!.length).toBe(33);
    expect(w.privateKey!.length).toBe(32);
    expect(w.publicKeyHash!.length).toBe(20);
    expect(w.privateKeyWif !== "undefined").toBeTruthy();
  });

  test("Get a testnet wallet from string id", async () => {
    let w = await TestNetWallet.fromId(
      "wif:testnet:cPS12C2bpGHtKjS5NXNyWyTGGRMPk7D7pjp5JfgxRKWyFnWoDyZg",
    );
    expect(w.publicKey!.length).toBe(65);
    expect(w.publicKeyCompressed!.length).toBe(33);
    expect(w.privateKey!.length).toBe(32);
    expect(w.publicKeyHash!.length).toBe(20);
    expect(w.cashaddr!.startsWith("bchtest:")).toBeTruthy();
  });

  test("Get a mainnet wallet from string id", async () => {
    let w = await Wallet.fromId(
      "wif:mainnet:KysvoRyDkxQycBGj49K8oC3minAfoXnVmkcgx6UsZx3g2VvyGCAa",
    );
    expect(w.publicKey!.length).toBe(65);
    expect(w.privateKey!.length).toBe(32);
    expect(w.publicKeyHash!.length).toBe(20);
    expect(w.cashaddr!.startsWith("bitcoincash")).toBeTruthy();
  });

  describe(`Errors from walletId`, () => {
    test("Expect Error passing testnet wallet to mainnet", async () => {
      await expect(
        TestNetWallet.fromId(
          "wif:testnet:KysvoRyDkxQycBGj49K8oC3minAfoXnVmkcgx6UsZx3g2VvyGCAa",
        ),
      ).rejects.toThrow("WIF is for mainnet, expected testnet");
    });

    test("Expect Error passing mainnet wallet to testnet", async () => {
      await expect(
        Wallet.fromId(
          "wif:mainnet:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
        ),
      ).rejects.toThrow("WIF is for testnet, expected mainnet");
    });

    test("A walletId without its network part does not quote the key back", async () => {
      const wif = "KysvoRyDkxQycBGj49K8oC3minAfoXnVmkcgx6UsZx3g2VvyGCAa";
      const seed =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
      const cases: [() => Promise<unknown>, string, string][] = [
        [
          () => Wallet.fromId(`wif:${wif}`),
          wif,
          "Unknown network prefix to a mainnet wallet",
        ],
        [
          () => Wallet.fromId(`seed:${seed}`),
          seed,
          "Unknown network prefix to a mainnet wallet",
        ],
        [
          () => HDWallet.fromId(`hd:${seed}`),
          seed,
          "Unknown network prefix to a mainnet wallet",
        ],
        // fromId is protected; replaceNamed and named reach it with a caller's or stored walletId
        [
          async () => (new WatchWallet() as any).fromId(wif),
          wif,
          "Unknown network prefix to a mainnet wallet",
        ],
      ];
      for (const [fn, secret, message] of cases) {
        const error: Error = await fn().then(
          () => Error("expected an error"),
          (e) => e,
        );
        expect(error.message).toBe(message);
        expect(error.message).not.toContain(secret);
      }
    });

    test("An empty key, address or name throws instead of making a random wallet", async () => {
      const cases: [() => Promise<unknown>, string][] = [
        [() => Wallet.fromWIF(""), "refusing to create wallet from empty WIF"],
        [
          () => WifWallet.fromWIF(""),
          "refusing to create wallet from empty WIF",
        ],
        [
          () => Wallet.fromId("wif:mainnet:"),
          "refusing to create wallet from empty WIF",
        ],
        [
          () => Wallet.fromId("wif:mainnet"),
          "refusing to create wallet from empty WIF",
        ],
        [
          () => Wallet.fromPrivateKey(""),
          "refusing to create wallet from empty private key",
        ],
        [
          () => Wallet.fromPrivateKey(new Uint8Array()),
          "refusing to create wallet from empty private key",
        ],
        [
          () => Wallet.fromId("privkey:mainnet:"),
          "refusing to create wallet from empty private key",
        ],
        [
          () => Wallet.fromSeed(""),
          "refusing to create wallet from empty mnemonic",
        ],
        [
          () => Wallet.fromId("seed:mainnet:"),
          "refusing to create wallet from empty mnemonic",
        ],
        [
          () => Wallet.fromId("seed:mainnet"),
          "refusing to create wallet from empty mnemonic",
        ],
        [
          () => Wallet.fromId("watch:mainnet:"),
          "address is required to create a watch-only wallet",
        ],
        [
          async () => (new WatchWallet() as any).fromId("watch:mainnet:"),
          "address is required to create a watch-only wallet",
        ],
        [
          async () => (new WatchWallet() as any).fromId("watch:mainnet"),
          "address is required to create a watch-only wallet",
        ],
        [
          () => Wallet.fromId("named:mainnet:"),
          "Named wallets must have a non-empty name",
        ],
        [
          () => Wallet.fromId("named:mainnet"),
          "Named wallets must have a non-empty name",
        ],
        [
          () => HDWallet.fromId("named:mainnet"),
          "Named wallets must have a non-empty name",
        ],
        [
          () => HDWallet.fromId("hd:mainnet:"),
          "refusing to create wallet from a walletId without a key",
        ],
        [
          () => HDWallet.fromId("hd:mainnet"),
          "refusing to create wallet from a walletId without a key",
        ],
        [
          () => HDWallet.fromId("hd:mainnet::0:0"),
          "refusing to create wallet from a walletId without a key",
        ],
        [
          () => HDWallet.fromSeed(""),
          "refusing to create wallet from empty mnemonic",
        ],
        [
          () => HDWallet.fromXPriv(""),
          "refusing to create wallet from empty xPriv",
        ],
        [
          () => HDWallet.fromXPub(""),
          "refusing to create wallet from empty xPub",
        ],
        [
          () => (HDWallet as any).fromXPriv(undefined),
          "refusing to create wallet from empty xPriv",
        ],
        // an empty key given to initialize, which fromId and the statics no longer pass
        [
          async () => (new HDWallet() as any).initialize({ mnemonic: "" }),
          "mnemonic, xPriv or xPub must be provided to create an HDWallet",
        ],
      ];
      for (const [fn, message] of cases) {
        const error: Error = await fn().then(
          () => Error("expected an error"),
          (e) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(message);
      }
    });

    test("Expect Error passing hd wallet", async () => {
      expect.assertions(1);
      try {
        await Wallet.fromId(
          "hd:mainnet:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
        );
      } catch (e: any) {
        expect(e.message).toBe("Unknown wallet type 'hd'");
      }
    });

    test("Expect Error passing unknown wallet", async () => {
      expect.assertions(1);
      try {
        await Wallet.fromId(
          "q2k:mainnet:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6",
        );
      } catch (e: any) {
        expect(e.message).toBe("Unknown wallet type 'q2k'");
      }
    });
  });
});

describe(`WIF validation`, () => {
  const key = new Uint8Array(32).fill(0x11);
  const mainnetWif = encodePrivateKeyWif(key, "mainnet");
  const testnetWif = encodePrivateKeyWif(key, "testnet");

  const errorOf = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      return e as Error;
    }
    throw Error("expected an error");
  };

  test("Errors never quote the WIF", async () => {
    const cases: [() => Promise<unknown>, string][] = [
      [() => Wallet.fromWIF(testnetWif), testnetWif],
      [() => TestNetWallet.fromWIF(mainnetWif), mainnetWif],
      [
        () => Wallet.fromWIF(encodePrivateKeyWif(key, "mainnetUncompressed")),
        encodePrivateKeyWif(key, "mainnetUncompressed"),
      ],
      [
        () => Wallet.fromWIF(mainnetWif.slice(0, -1) + "x"),
        mainnetWif.slice(0, -1),
      ],
      [
        () => Wallet.fromWIF(mainnetWif.slice(0, -1) + "0"),
        mainnetWif.slice(0, -1),
      ],
    ];
    for (const [fn, secret] of cases) {
      const error = await errorOf(fn);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain(secret.slice(0, 20));
    }
  });

  test("Uncompressed WIFs are rejected on every network", async () => {
    const mainnetUncompressed = encodePrivateKeyWif(key, "mainnetUncompressed");
    const testnetUncompressed = encodePrivateKeyWif(key, "testnetUncompressed");
    expect(mainnetUncompressed[0]).toBe("5");
    await expect(Wallet.fromWIF(mainnetUncompressed)).rejects.toThrow(
      "Uncompressed WIF private keys are not supported",
    );
    await expect(TestNetWallet.fromWIF(testnetUncompressed)).rejects.toThrow(
      "Uncompressed WIF private keys are not supported",
    );
    await expect(RegTestWallet.fromWIF(testnetUncompressed)).rejects.toThrow(
      "Uncompressed WIF private keys are not supported",
    );
    await expect(
      RegTestWallet.fromId(`wif:regtest:${mainnetUncompressed}`),
    ).rejects.toThrow("Uncompressed WIF private keys are not supported");
  });

  test("A base58check string that is not a WIF is rejected", async () => {
    // a P2PKH legacy address: valid base58check, version 0, 20-byte payload
    await expect(
      Wallet.fromWIF("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
    ).rejects.toThrow("Invalid WIF: unknown version byte");
    // right version byte, 31-byte payload
    await expect(
      Wallet.fromWIF(
        encodeBase58AddressFormat(0x80, new Uint8Array(31).fill(0x11)),
      ),
    ).rejects.toThrow("Invalid WIF: unexpected payload length");
  });

  test("Compressed WIFs still decode to the key's address", async () => {
    const mainnet = await Wallet.fromWIF(mainnetWif);
    expect(binToHex(mainnet.privateKey!)).toBe(binToHex(key));
    expect(mainnet.privateKeyWif).toBe(mainnetWif);
    const regtest = await RegTestWallet.fromWIF(testnetWif);
    expect(binToHex(regtest.privateKey!)).toBe(binToHex(key));
    expect(regtest.cashaddr).toBe(
      (await RegTestWallet.fromPrivateKey(key)).cashaddr,
    );
  });
});

describe(`Mnemonic wallet creation`, () => {
  test("Expect '11x abandon about' to have the correct key, seed and path", async () => {
    let w = await Wallet.fromId(
      "seed:mainnet:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(w.cashaddr!).toBe(
      "bitcoincash:qrvcdmgpk73zyfd8pmdl9wnuld36zh9n4gms8s0u59",
    );
    expect(w.privateKeyWif!).toBe(
      "L4p2b9VAf8k5aUahF1JCJUzZkgNEAqLfq8DDdQiyAprQAKSbu8hf",
    );
    expect(w.getSeed().seed).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(w.getSeed().derivationPath).toBe("m/44'/0'/0'/0/0");
    const info = {
      cashaddr: "bitcoincash:qrvcdmgpk73zyfd8pmdl9wnuld36zh9n4gms8s0u59",
      tokenaddr: "bitcoincash:zrvcdmgpk73zyfd8pmdl9wnuld36zh9n4gu65wp6tk",
      isTestnet: false,
      name: "",
      network: "mainnet",
      privateKey:
        "e284129cc0922579a535bbf4d1a3b25773090d28c909bc0fed73b5e0222cc372",
      privateKeyWif: "L4p2b9VAf8k5aUahF1JCJUzZkgNEAqLfq8DDdQiyAprQAKSbu8hf",
      publicKey:
        "04aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e9370164133294e5fd1679672fe7866c307daf97281a28f66dca7cbb52919824f",
      publicKeyHash: "d986ed01b7a22225a70edbf2ba7cfb63a15cb3aa",

      parentXPubKey:
        "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj",
      parentDerivationPath: "m/44'/0'/0'",
      derivationPath: "m/44'/0'/0'/0/0",
      seed: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",

      walletDbEntry:
        "seed:mainnet:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about:m/44'/0'/0'/0/0",
      walletId:
        "seed:mainnet:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about:m/44'/0'/0'/0/0",
    };
    expect(w.getInfo()).toEqual(info);
  });

  test("Expect '11x abandon about' to have the correct key, seed and path when generated on 145' coin path", async () => {
    let w = await Wallet.fromId(
      "seed:mainnet:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about:m/44'/145'/0'/0/0",
    );
    expect(w.cashaddr!).toBe(
      "bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6",
    );
    expect(w.privateKeyWif!).toBe(
      "KxbEv3FeYig2afQp7QEA9R3gwqdTBFwAJJ6Ma7j1SkmZoxC9bAXZ",
    );
    expect(w.getSeed().seed).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(w.getSeed().derivationPath).toBe("m/44'/145'/0'/0/0");
    expect(w.getSeed().parentDerivationPath).toBe("m/44'/145'/0'");
  });
  test("Expect '11x abandon about' to have the correct key, seed and path from regtest wallet", async () => {
    let w = await RegTestWallet.fromId(
      "seed:regtest:abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(w.cashaddr!).toBe(
      "bchreg:qrvcdmgpk73zyfd8pmdl9wnuld36zh9n4g974kwcsl",
    );
    expect(w.privateKeyWif!).toBe(
      "cVB244V26CSLjv3xdR7KfoVdNufdqHSMuAMgjqBUfwWQR4WVFsky",
    );
    expect(w.getSeed().seed).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    expect(w.getSeed().derivationPath).toBe("m/44'/0'/0'/0/0");
  });
});

describe(`Watch only Wallets`, () => {
  test("Create a watch only testnet wallet from string id", async () => {
    let w = await TestNetWallet.fromId(
      "watch:testnet:qppr9h7whx9pzucgqukhtlj8lvgvjlgr3g9ggtkq22",
    );
    expect(w.network).toBe("testnet");
    expect(w.networkPrefix).toBe("bchtest");
    expect(w.cashaddr).toBe(
      "bchtest:qppr9h7whx9pzucgqukhtlj8lvgvjlgr3g9ggtkq22",
    );
    expect(w.getInfo()).toStrictEqual({
      cashaddr: "bchtest:qppr9h7whx9pzucgqukhtlj8lvgvjlgr3g9ggtkq22",
      tokenaddr: "bchtest:zppr9h7whx9pzucgqukhtlj8lvgvjlgr3gzzm4cx4e",
      derivationPath: undefined,
      isTestnet: true,
      name: "",
      network: "testnet",
      parentDerivationPath: undefined,
      parentXPubKey: undefined,
      privateKey: undefined,
      privateKeyWif: undefined,
      publicKey: undefined,
      publicKeyHash: "4232dfceb98a117308072d75fe47fb10c97d038a",
      seed: undefined,
      walletDbEntry:
        "watch:testnet:bchtest:qppr9h7whx9pzucgqukhtlj8lvgvjlgr3g9ggtkq22",
      walletId:
        "watch:testnet:bchtest:qppr9h7whx9pzucgqukhtlj8lvgvjlgr3g9ggtkq22",
    });
  });

  test("Create a watch only regtest wallet from string id", async () => {
    let w = await RegTestWallet.fromId(
      "watch:regtest:qql8ypk6y9qksmjj2qp3r5fr3ne35ltkzss902evnt",
    );
    if (!w) {
      throw Error("Could not derive wallet");
    }

    // the balance unit may also be empty
    expect(await w.getBalance()).toBe(0n);
    expect(w.network).toBe("regtest");
    expect(w.networkPrefix).toBe("bchreg");
    expect(w.cashaddr).toBe(
      "bchreg:qql8ypk6y9qksmjj2qp3r5fr3ne35ltkzss902evnt",
    );
  });

  test("Create a watch only mainnet wallet from string id", async () => {
    let w = await Wallet.fromId(
      "watch:mainnet:qp6e6enhpy0fwwu7nkvlr8rgl06ru0c9lywalz8st5",
    );
    expect(w.network).toBe("mainnet");
    expect(w.networkPrefix).toBe("bitcoincash");
    expect(w.cashaddr).toBe(
      "bitcoincash:qp6e6enhpy0fwwu7nkvlr8rgl06ru0c9lywalz8st5",
    );
  });

  test("Should get the regtest wallet balance", async () => {
    // Build Alice's wallet from Wallet Import Format string, send some sats
    if (!process.env.ADDRESS) {
      throw Error("Attempted to pass an empty address");
    } else {
      let alice = await RegTestWallet.watchOnly(process.env.ADDRESS); // insert WIF from #1
      // Build Bob's wallet from a public address, check his balance.
      expect(alice.getPublicKeyHash()!.length).toBe(20);
      const aliceBalance = await alice.getBalance();
      expect(aliceBalance).toBeGreaterThan(5000n * bchParam.subUnits);
    }
  });

  test.skipIf(!liveTests)(
    "Should get the regtest wallet balance in eur",
    async () => {
      // Build Alice's wallet from Wallet Import Format string, send some sats
      if (!process.env.ADDRESS) {
        throw Error("Attempted to pass an empty address");
      } else {
        let alice = await RegTestWallet.watchOnly(process.env.ADDRESS); // insert WIF from #1
        // Build Bob's wallet from a public address, check his balance.
        expect(alice.getPublicKeyHash()!.length).toBe(20);
        const aliceBalance = await alice.getBalance();
        expect(
          await convert(Number(aliceBalance), "sat", "eur"),
        ).toBeGreaterThan(0);
        expect(
          await convert(
            Number(await (await RegTestWallet.newRandom()).getBalance()),
            "sat",
            "eur",
          ),
        ).toBe(0);
      }
    },
  );

  (process.env.ALICE_TESTNET_WALLET_ID ? test : test.skip)(
    "Should send to testnet coins to a random address",
    async () => {
      let alice = await TestNetWallet.fromId(
        process.env.ALICE_TESTNET_WALLET_ID!,
      );
      expect(alice.getPublicKeyHash()!.length).toBe(20);
      await alice.send([{ cashaddr: alice.cashaddr!, value: 720n }]);
      expect(await alice.getBalance()).toBeGreaterThan(5000n);
    },
  );

  (process.env.ALICE_TESTNET_ADDRESS ? test : test.skip)(
    "Should get the testnet wallet balance",
    async () => {
      let alice = await TestNetWallet.watchOnly(
        process.env.ALICE_TESTNET_ADDRESS!,
      );
      const aliceBalance = await alice.getBalance();
      expect(aliceBalance).toBeGreaterThan(2000n);
    },
  );

  test("Should build without broadcasting and submit a transaction", async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();

    const built = await aliceWallet.send(
      { cashaddr: bobWallet.cashaddr!, value: 2000n },
      { broadcast: false },
    );
    expect(await bobWallet.getBalance()).toBe(0n);

    const txId = await aliceWallet.submitTransaction(
      hexToBin(built.transaction),
    );
    expect(txId).toBe(built.txId);

    expect(await bobWallet.getBalance()).toBe(2000n);
  });

  test("Should get last transaction", async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();

    expect(await bobWallet.getLastTransaction()).toBeNull();

    await aliceWallet.send([
      {
        cashaddr: bobWallet.cashaddr!,
        value: 2000n,
      },
    ]);

    expect(await bobWallet.getLastTransaction()).not.toBeNull();
  });
});
describe(`Wallet subscriptions`, () => {
  test("Should wait for transaction", async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();

    const [, response] = await Promise.all([
      delay(0).then(() =>
        aliceWallet.send([
          {
            cashaddr: bobWallet.cashaddr!,
            value: 1000n,
          },
        ]),
      ),
      bobWallet.waitForTransaction({
        getTransactionInfo: true,
        getBalance: true,
      }),
    ]);
    expect(response.balance).toBeGreaterThan(0);
    expect(response.transactionInfo!.hash).not.toBe("");

    await bobWallet.sendMax(aliceWallet.cashaddr!);
  });

  test("Should await transaction propagation", async () => {
    const aliceWallet = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bobWallet = await RegTestWallet.newRandom();

    // the balance includes the send when it returns
    const balanceBefore = await aliceWallet.getBalance();
    await aliceWallet.send([{ cashaddr: bobWallet.cashaddr!, value: 1000n }]);
    expect(await aliceWallet.getBalance()).toBeLessThan(balanceBefore);
    expect(await bobWallet.getBalance()).toBe(1000n);
  });

  test.skipIf(!liveTests)(
    "Create two wallets, get balances concurrently",
    async () => {
      const [balance1, balance2] = await Promise.all([
        Wallet.newRandom().then((wallet) => wallet.getBalance()),
        Wallet.newRandom().then((wallet) => wallet.getBalance()),
      ]);
      expect(balance1).toBe(0n);
      expect(balance2).toBe(0n);
    },
  );

  test("Should watch then wait", async () => {
    const aliceWallet = await RegTestWallet.newRandom();

    let cancel = await aliceWallet.watchBalance(() => {});

    await cancel();
  });

  test("Should wait for balance", async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();

    const sent = aliceWallet.send([
      {
        cashaddr: bobWallet.cashaddr!,
        value: 2000n,
      },
    ]);

    let balance = await bobWallet.waitForBalance(2000n);
    expect(balance).toBeGreaterThanOrEqual(2000n);
    await sent;
    await bobWallet.sendMax(aliceWallet.cashaddr!);
  });

  test("Should watch balance, then waitForBalance, then cancel watch", async () => {
    const aliceId = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const alice = await RegTestWallet.fromId(aliceId);
    const bob = await RegTestWallet.newRandom();
    const sent = alice.send([
      {
        cashaddr: bob.cashaddr!,
        value: 2000n,
      },
    ]);

    let cancel = await bob.watchBalance(() => {});
    let balance = await bob.waitForBalance(2000n);
    expect(balance).toBe(2000n);
    await sent;
    await cancel();
  });

  test("Should watch multiple wallets", async () => {
    const aliceId = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const alice = await RegTestWallet.fromId(aliceId);
    const bob = await RegTestWallet.newRandom();
    const charlie = await RegTestWallet.newRandom();
    const dave = await RegTestWallet.newRandom();

    const [, bobBalance] = await Promise.all([
      delay(600).then(() =>
        alice.send([
          {
            cashaddr: bob.cashaddr!,
            value: 1000n,
          },
        ]),
      ),
      bob.waitForBalance(1000n),
    ]);
    const [, charlieBalance] = await Promise.all([
      delay(600).then(() =>
        alice.send([
          {
            cashaddr: charlie.cashaddr!,
            value: 1000n,
          },
        ]),
      ),
      charlie.waitForBalance(1000n),
    ]);
    const [, daveBalance] = await Promise.all([
      delay(600).then(() =>
        alice.send([
          {
            cashaddr: dave.cashaddr!,
            value: 1000n,
          },
        ]),
      ),
      dave.waitForBalance(1000n),
    ]);
    expect(bobBalance).toBe(1000n);
    expect(charlieBalance).toBe(1000n);
    expect(daveBalance).toBe(1000n);
    let [, bobResponse] = await Promise.all([
      delay(600).then(() =>
        alice.send([
          {
            cashaddr: bob.cashaddr!,
            value: 1000n,
          },
        ]),
      ),
      bob.waitForTransaction(),
    ]);
    expect(bobResponse.transactionInfo!.version).toBe(2);
    [, bobResponse] = await Promise.all([
      delay(600).then(() =>
        alice.send([
          {
            cashaddr: bob.cashaddr!,
            value: 1000n,
          },
        ]),
      ),
      bob.waitForTransaction(),
    ]);
    expect(bobResponse.transactionInfo!.version).toBe(2);
    [, bobResponse] = await Promise.all([
      delay(600).then(() =>
        alice.send([
          {
            cashaddr: bob.cashaddr!,
            value: 1000n,
          },
        ]),
      ),
      bob.waitForTransaction(),
    ]);
    expect(bobResponse.transactionInfo!.version).toBe(2);
    expect(await bob.getBalance()).toBe(4000n);
  });

  test("Test waiting and watching", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);

    const bob = await RegTestWallet.newRandom();

    let waitTxResult = false;
    const waitTx = delay(0).then(async () => {
      const result = await alice.waitForTransaction({
        getBalance: true,
        getTransactionInfo: true,
      });
      expect(result.balance!).toBeGreaterThan(0);
      expect(result.transactionInfo!.hash.length).toBe(64);
      waitTxResult = true;
    });

    let waitBalanceResult = false;
    const waitBalance = delay(0).then(async () => {
      const result = await alice.waitForBalance(100_000n);
      expect(result).toBeGreaterThan(0n);
      waitBalanceResult = true;
    });

    let aliceWatchResult = false;
    let aliceWatchCancel: CancelFn;
    aliceWatchCancel = await alice.watchStatus(async (_status) => {
      await aliceWatchCancel?.();
      aliceWatchResult = true;
    });

    let bobWatchResult = false;
    let bobTransactionId = "";
    let bobWatchCancel: CancelFn;
    bobWatchCancel = await bob.watchTransactionHashes(async (txHash) => {
      await bobWatchCancel?.();
      bobWatchResult = true;
      bobTransactionId = txHash;
    });

    let bobBalanceWatchResult = false;
    let bobBalanceWatchCancel: CancelFn;
    bobBalanceWatchCancel = await bob.watchBalance(async (balance) => {
      // skip if balance is zero yet
      if (!balance) {
        return;
      }

      expect(balance).toBe(100_000n);
      await bobBalanceWatchCancel?.();
      bobBalanceWatchResult = true;
    });

    let blockWatchResult = false;
    let blockWatchCancel: CancelFn;
    blockWatchCancel = await bob.watchBlocks(async (block) => {
      expect(block.height).toBeGreaterThan(1);
      await blockWatchCancel?.();
      blockWatchResult = true;
    });

    const blockNumber = await alice.provider!.getBlockHeight();

    let blockWaitResult = false;
    const blockWait = delay(0).then(async () => {
      const result = await alice.waitForBlock(blockNumber + 1);
      expect(result.height).toBe(blockNumber + 1);
      blockWaitResult = true;
    });

    let blockNumberWaitResult = false;
    const blockNumberWait = delay(0).then(async () => {
      const result = await alice.waitForBlock(blockNumber + 2);
      expect(result.height).toBe(blockNumber + 2);
      blockNumberWaitResult = true;
    });

    const sendResponse = await alice.send({
      cashaddr: bob.getDepositAddress(),
      value: BigInt(await convert(0.001, "bch", "sat")),
    });

    await mine({ cashaddr: alice.cashaddr!, blocks: 1 });
    await delay(1000);
    await mine({ cashaddr: alice.cashaddr!, blocks: 1 });

    await delay(5000);
    await Promise.all([waitTx, waitBalance, blockWait, blockNumberWait]);
    expect(waitTxResult).toBe(true);
    expect(waitBalanceResult).toBe(true);
    expect(aliceWatchResult).toBe(true);
    expect(bobWatchResult).toBe(true);
    expect(bobTransactionId).toBe(sendResponse.txId);
    expect(bobBalanceWatchResult).toBe(true);
    expect(blockWatchResult).toBe(true);
    expect(blockWaitResult).toBe(true);
    expect(blockNumberWaitResult).toBe(true);
  });

  test("Should report only transactions that are new after the watch started (mainnet-js#257)", async () => {
    const alice = await RegTestWallet.fromId(process.env.ALICE_ID!);
    const bob = await RegTestWallet.newRandom();

    // History before the watch: two confirmed fundings and an unconfirmed token genesis
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await alice.send({ cashaddr: bob.cashaddr!, value: 10000n });
    await mine({ cashaddr: alice.cashaddr!, blocks: 1 });
    const genesis = await bob.tokenGenesis({ amount: 100n });
    const category = genesis.categories![0];
    await delay(1000);
    expect((await bob.getRawHistory()).length).toBe(3);

    const hashes: string[] = [];
    const transactions: string[] = [];
    const tokenTransactions: string[] = [];
    const cancels = [
      await bob.watchTransactionHashes((txHash) => hashes.push(txHash)),
      await bob.watchTransactions((tx) => transactions.push(tx.txid)),
      await bob.watchTokenTransactions((tx) => tokenTransactions.push(tx.txid)),
    ];
    await delay(1000);
    expect(hashes).toEqual([]);
    expect(transactions).toEqual([]);
    expect(tokenTransactions).toEqual([]);

    const sendResponse = await bob.send(
      new TokenSendRequest({
        cashaddr: bob.getTokenDepositAddress(),
        category,
        amount: 100n,
      }),
    );
    await delay(1000);
    // confirming the new transaction and the genesis reports neither again
    await mine({ cashaddr: alice.cashaddr!, blocks: 1 });
    await delay(1000);
    await Promise.all(cancels.map((cancel) => cancel()));

    expect(hashes).toEqual([sendResponse.txId]);
    expect(transactions).toEqual([sendResponse.txId]);
    expect(tokenTransactions).toEqual([sendResponse.txId]);
  });
});

describe(`Wallet extrema behavior regression testing`, () => {
  test(`Should operate very well above dust threshold (${
    DUST * 3n
  }), 'min relay fee not met (code 66)' regression`, async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();
    const charlieWallet = await RegTestWallet.newRandom();

    await aliceWallet.send([
      { cashaddr: bobWallet.cashaddr!, value: DUST },
      { cashaddr: bobWallet.cashaddr!, value: DUST * 3n },
    ]);

    await bobWallet.send({
      cashaddr: charlieWallet.cashaddr!,
      value: DUST,
    });
    await charlieWallet.waitForUpdate();
    expect(await charlieWallet.getBalance()).toBe(DUST);
  });

  test(`Should operate very well above dust threshold (${
    DUST * 2n
  }), 'min relay fee not met (code 66)' regression`, async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();
    const charlieWallet = await RegTestWallet.newRandom();

    await aliceWallet.send([
      { cashaddr: bobWallet.cashaddr!, value: DUST },
      { cashaddr: bobWallet.cashaddr!, value: DUST * 2n },
    ]);

    await bobWallet.send({
      cashaddr: charlieWallet.cashaddr!,
      value: DUST,
    });
    await charlieWallet.waitForUpdate();
    expect(await charlieWallet.getBalance()).toBe(DUST);
  });

  test(`Should operate well above dust threshold (${
    DUST + 328n
  }), 'min relay fee not met (code 66)' regression`, async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();
    const charlieWallet = await RegTestWallet.newRandom();

    await aliceWallet.send([
      { cashaddr: bobWallet.cashaddr!, value: DUST },
      { cashaddr: bobWallet.cashaddr!, value: DUST + 328n },
    ]);

    await bobWallet.send([{ cashaddr: charlieWallet.cashaddr!, value: DUST }]);
    await charlieWallet.waitForUpdate();
    expect(await charlieWallet.getBalance()).toBe(DUST);
  });

  test(`Should operate slightly above dust threshold (${
    DUST + 1n
  }), 'min relay fee not met (code 66)' regression`, async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();
    const charlieWallet = await RegTestWallet.newRandom();

    await aliceWallet.send([
      { cashaddr: bobWallet.cashaddr!, value: DUST },
      { cashaddr: bobWallet.cashaddr!, value: DUST + 1n },
    ]);

    await bobWallet.send([{ cashaddr: charlieWallet.cashaddr!, value: DUST }]);
    await charlieWallet.waitForUpdate();
    expect(await charlieWallet.getBalance()).toBe(DUST);
  });

  test(`Should operate with dust threshold (${DUST}), 'min relay fee not met (code 66)' regression`, async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();
    const charlieWallet = await RegTestWallet.newRandom();

    await aliceWallet.send([
      { cashaddr: bobWallet.cashaddr!, value: DUST },
      { cashaddr: bobWallet.cashaddr!, value: DUST },
    ]);

    await bobWallet.send([{ cashaddr: charlieWallet.cashaddr!, value: DUST }]);
    await charlieWallet.waitForUpdate();
    expect(await charlieWallet.getBalance()).toBe(DUST);
  });
  test(`Should throw error with dust amounts (${
    DUST - 1n
  }), 'min relay fee not met (code 66)' regression`, async () => {
    expect.assertions(3);
    try {
      const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
      const aliceWallet = await RegTestWallet.fromId(aliceWif);
      const bobWallet = await RegTestWallet.newRandom();
      const charlieWallet = await RegTestWallet.newRandom();

      await aliceWallet.send([
        { cashaddr: bobWallet.cashaddr!, value: DUST },
        { cashaddr: bobWallet.cashaddr!, value: DUST - 1n },
      ]);

      await bobWallet.send([
        { cashaddr: charlieWallet.cashaddr!, value: DUST },
      ]);
    } catch (e: any) {
      expect(e.message).toBe(
        `the transaction was rejected by network rules.\n\ndust (code 64)\n`,
      );
      expect(e).toBeInstanceOf(BroadcastRejectedError);
      expect(e).toMatchObject({ reason: "dust" });
    }
  });

  test("Send op_return data", async () => {
    let wallet = await RegTestWallet.fromId(process.env.ALICE_ID!);
    let result: SendResponse, transaction: ElectrumRawTransaction;

    result = await wallet.send([
      OpReturnData.fromArray(["MEMO\x10LÖL😅"]),
      { cashaddr: wallet.cashaddr!, value: 546n },
    ]);
    transaction = await wallet.provider!.getRawTransactionObject(result.txId!);
    expect(transaction.vout[0].scriptPubKey.asm).toContain("OP_RETURN");
    expect(transaction.vout[0].scriptPubKey.hex.slice(4)).toBe(
      binToHex(utf8ToBin("MEMO\x10LÖL😅")),
    );

    result = await wallet.send([
      { cashaddr: wallet.cashaddr!, value: 546n },
      OpReturnData.fromArray([Uint8Array.from([0x00, 0x01, 0x02])]),
    ]);
    transaction = await wallet.provider!.getRawTransactionObject(result.txId!);
    expect(transaction.vout[1].scriptPubKey.asm).toContain("OP_RETURN");
    expect([
      ...hexToBin(transaction.vout[1].scriptPubKey.hex.slice(4)),
    ]).toStrictEqual([0x00, 0x01, 0x02]);

    result = await wallet.send([
      OpReturnData.fromArray([""]),
      OpReturnData.fromArray([Uint8Array.from([])]),
    ]);
    transaction = await wallet.provider!.getRawTransactionObject(result.txId!);
    expect(transaction.vout[0].scriptPubKey.asm).toContain("OP_RETURN");
    expect([...hexToBin(transaction.vout[0].scriptPubKey.hex)]).toStrictEqual([
      0x6a, 0x00,
    ]);
    expect(transaction.vout[1].scriptPubKey.asm).toContain("OP_RETURN");
    expect([...hexToBin(transaction.vout[1].scriptPubKey.hex)]).toStrictEqual([
      0x6a, 0x00,
    ]);
  });

  test("Send op_return outputs up to 223 bytes in total", async () => {
    const wallet = await RegTestWallet.fromId(process.env.ALICE_ID!);

    // one 223-byte script: OP_RETURN, OP_PUSHDATA1 <220>, 220 bytes
    const full = OpReturnData.fromArray([new Uint8Array(220).fill(1)]);
    let result = await wallet.send([full]);
    let transaction = await wallet.provider!.getRawTransactionObject(
      result.txId!,
    );
    expect(transaction.vout[0].scriptPubKey.hex).toBe(binToHex(full.buffer));

    // 223 bytes over two outputs: 1 + 2 + 100 and 1 + 2 + 117
    const first = OpReturnData.fromArray([new Uint8Array(100).fill(2)]);
    const second = OpReturnData.fromArray([new Uint8Array(117).fill(3)]);
    result = await wallet.send([first, second]);
    transaction = await wallet.provider!.getRawTransactionObject(result.txId!);
    expect(transaction.vout[0].scriptPubKey.hex).toBe(binToHex(first.buffer));
    expect(transaction.vout[1].scriptPubKey.hex).toBe(binToHex(second.buffer));

    // one byte more over the two is refused before anything is sent
    const third = OpReturnData.fromArray([new Uint8Array(118).fill(3)]);
    await expect(wallet.send([first, third])).rejects.toThrow(
      "OP_RETURN outputs can not exceed 223 bytes in total, got 224",
    );
  });

  test("Should send with utxoIds", async () => {
    const aliceWif = `wif:regtest:${process.env.PRIVATE_WIF!}`;
    const aliceWallet = await RegTestWallet.fromId(aliceWif);
    const bobWallet = await RegTestWallet.newRandom();

    const aliceUtxos = await aliceWallet.getUtxos();

    await expect(
      aliceWallet.send(
        {
          cashaddr: bobWallet.cashaddr!,
          value: 1000n,
        },
        { utxoIds: ["00ab:1", "00cd:2"] },
      ),
    ).rejects.toThrow("not found in wallet");

    await expect(
      aliceWallet.send(
        {
          cashaddr: bobWallet.cashaddr!,
          value: 1000n,
        },
        {
          utxoIds: [
            toUtxoId(aliceUtxos[0]),
            `${aliceUtxos[1].txid}:${aliceUtxos[1].vout}`,
          ],
        },
      ),
    ).resolves.not.toThrow();
  });
});
