//#region Imports
import type { TokenBurnAllowance } from "../transaction/tokenConservation.js";
import {
  assertSuccess,
  binToHex,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveSeedFromBip39Mnemonic,
  encodePrivateKeyWif,
  generateBip39Mnemonic,
  hexToBin,
  secp256k1,
} from "@bitauth/libauth";
import { Config } from "../config.js";
import { NetworkType } from "../enum.js";
import { checkForEmptySeed } from "../util/checkForEmptySeed.js";
import { wifPrivateKey } from "../util/decodeWif.js";
import { WalletTypeEnum } from "./enum.js";
import { SendRequestOptionsI, WalletFactoryOptions } from "./interface.js";
import {
  OpReturnData,
  SendRequest,
  SendResponse,
  TokenSendRequest,
} from "./model.js";
import { WatchWallet } from "./Watch.js";
import { networkPrefixError, walletIdKind } from "../util/walletIdError.js";
import { InvalidWalletIdError } from "./errors.js";
//#endregion Imports

export interface WalletOptions {
  name?: string;
  mnemonic?: string;
  derivationPath?: string;
  privateKey?: Uint8Array;
  privateKeyWif?: string;
  publicKeyCompressed?: Uint8Array;
  publicKeyHash?: Uint8Array;
  address?: string;
}

/**
 * Class to manage a bitcoin cash wallet.
 */
// what a walletId of each type this class loads lacks when its value part is empty; a named
// id's empty name is fromNamedId's to refuse
const missingValueMessages: Record<string, string> = {
  [WalletTypeEnum.Wif]: "refusing to create wallet from empty WIF",
  [WalletTypeEnum.PrivateKey]:
    "refusing to create wallet from empty private key",
  [WalletTypeEnum.Seed]: "refusing to create wallet from empty mnemonic",
  [WalletTypeEnum.Watch]: "address is required to create a watch-only wallet",
};

export class Wallet extends WatchWallet {
  readonly derivationPath: string = Config.DefaultParentDerivationPath + "/0/0";
  readonly mnemonic!: string;
  readonly privateKey!: Uint8Array;
  readonly privateKeyWif!: string;

  declare name: string;

  //#region Constructors and Statics
  constructor(name = "", network = NetworkType.Mainnet) {
    super(name, network);

    this.name = name;
    // @ts-ignore
    this.walletType = WalletTypeEnum.Seed;
  }

  /// Initialize the wallet given the options mnemonic, privateKey or publicKey variations
  /// If none provided, a new random mnemonic will be generated
  /// If mnemonic or private key provided, the wallet will be able to sign transactions
  /// Otherwise, the wallet will be watch-only
  /// This internal method is called by the various static constructors
  protected async initialize({
    name = "",
    mnemonic,
    derivationPath,
    privateKey,
    privateKeyWif,
    publicKeyCompressed,
    publicKeyHash,
    address,
  }: WalletOptions = {}) {
    // seed wallet
    if (this.walletType === WalletTypeEnum.Seed && !mnemonic) {
      mnemonic = generateBip39Mnemonic();
    }

    if (mnemonic?.length) {
      mnemonic = mnemonic.trim().toLowerCase();
      if (![12, 24].includes(mnemonic.split(" ").length)) {
        throw Error("Invalid mnemonic, must be 12 or 24 words");
      }

      if (!derivationPath) {
        derivationPath = Config.DefaultParentDerivationPath + "/0/0";
      }

      // @ts-ignore
      this.mnemonic = mnemonic;
      // @ts-ignore
      this.derivationPath = derivationPath;

      const seed = deriveSeedFromBip39Mnemonic(this.mnemonic);
      checkForEmptySeed(seed);

      const rootNode = deriveHdPrivateNodeFromSeed(seed, {
        assumeValidity: true,
        throwErrors: true,
      });
      const childNode = deriveHdPath(rootNode, this.derivationPath);
      privateKey = childNode.privateKey;
    }

    if (privateKey?.length) {
      // @ts-ignore
      this.privateKey = privateKey;

      privateKeyWif = encodePrivateKeyWif(
        privateKey,
        this.network === NetworkType.Regtest
          ? NetworkType.Testnet
          : this.network,
      );
    }

    if (privateKeyWif?.length) {
      if (!this.privateKey) {
        // @ts-ignore
        this.privateKey = wifPrivateKey(privateKeyWif, this.network);
      }

      // @ts-ignore
      this.privateKeyWif = privateKeyWif;

      publicKeyCompressed = assertSuccess(
        secp256k1.derivePublicKeyCompressed(this.privateKey),
      );
    }

    // rest cases are for watch wallets
    await super.initialize({
      name,
      publicKeyCompressed,
      publicKeyHash,
      address,
    });

    return this;
  }

  //#endregion Constructors and Statics

  //#region Statics
  /**
   * fromId - create a wallet from encoded walletId string: `seed:<network>:<mnemonic>[:<derivation
   * path>]`, `wif:<network>:<wif>`, `privkey:<network>:<hex key>`, `watch:<network>:<address>` or
   * `named:<network>:<name>`
   *
   * @param walletId   walletId options to steer the creation process
   * @param options   the wallet's provider
   *
   * @returns wallet instantiated accordingly to the walletId rules
   */
  public static async fromId<T extends typeof Wallet>(
    this: T,
    walletId: string,
    options?: WalletFactoryOptions,
  ): Promise<InstanceType<T>> {
    return this.create(options).fromId(walletId) as Promise<InstanceType<T>>;
  }

  /**
   * fromWIF - create a wallet using the private key supplied in `Wallet Import Format`
   *
   * @param wif   WIF encoded private key string
   * @param options   the wallet's provider
   *
   * @returns instantiated wallet
   */
  public static async fromWIF<T extends typeof Wallet>(
    this: T,
    wif: string,
    options?: WalletFactoryOptions,
  ): Promise<InstanceType<T>> {
    return this.create(options).fromWIF(wif) as Promise<InstanceType<T>>;
  }

  /**
   * newRandom - create a random wallet
   *
   * if `name` parameter is specified, the wallet is got or created as with `named(name)`
   *
   * @param name   user friendly wallet alias
   * @param options   the wallet's provider
   *
   * @returns instantiated wallet
   */
  public static async newRandom<T extends typeof Wallet>(
    this: T,
    name: string = "",
    options?: WalletFactoryOptions,
  ): Promise<InstanceType<T>> {
    return this.create(options).newRandom(name) as Promise<InstanceType<T>>;
  }
  //#endregion Constructors

  //#region Protected implementations
  protected fromId = async (walletId: string): Promise<this> => {
    const [walletType, networkGiven, arg1, arg2]: string[] =
      walletId.split(":");

    if (this.network !== networkGiven) {
      throw networkPrefixError(walletType, networkGiven, this.network);
    }

    if (!arg1 && Object.hasOwn(missingValueMessages, walletType)) {
      throw new InvalidWalletIdError(missingValueMessages[walletType], {
        kind: walletType,
        reason: "missing-value",
      });
    }

    // "wif:regtest:cNfsPtqN2bMRS7vH5qd8tR8GMvgXyL5BjnGAKgZ8DYEiCrCCQcP6"
    switch (walletType) {
      case WalletTypeEnum.PrivateKey:
        return this.fromPrivateKey(arg1);

      case WalletTypeEnum.Wif:
        return this.fromWIF(arg1);

      case WalletTypeEnum.Watch:
        if (arg2) {
          // watch:testnet:bchtest:qq1234567
          return this.watchOnly(`${arg1}:${arg2}`);
        }
        // watch:testnet:qq1234567
        return this.watchOnly(`${arg1}`);

      case WalletTypeEnum.Named:
        // named:testnet:wallet_1, or named:testnet:wallet_1:bchtest
        return this.fromNamedId(arg1, arg2);

      case WalletTypeEnum.Seed:
        if (arg2) {
          // seed:testnet:table later ... stove kitten pluck:m/44'/0'/0'/0/0
          return this.fromSeed(arg1, arg2);
        }
        // seed:testnet:table later ... stove kitten pluck
        return this.fromSeed(arg1);

      default:
        throw new InvalidWalletIdError(`Unknown wallet type '${walletType}'`, {
          kind: walletIdKind(walletType),
          reason: "kind",
        });
    }
  };

  // Initialize wallet from a mnemonic phrase
  protected async fromSeed(
    mnemonic: string,
    derivationPath?: string,
  ): Promise<this> {
    if (!mnemonic?.length) {
      throw Error("refusing to create wallet from empty mnemonic");
    }

    // @ts-ignore
    this.walletType = WalletTypeEnum.Seed;

    await this.initialize({ mnemonic, derivationPath });

    return this;
  }

  // Initialize wallet from private key in hex or Uint8Array
  protected async fromPrivateKey(
    privateKey: string | Uint8Array,
  ): Promise<this> {
    if (!privateKey?.length) {
      throw Error("refusing to create wallet from empty private key");
    }
    if (typeof privateKey === "string") {
      privateKey = hexToBin(privateKey);
    }

    // @ts-ignore
    this.walletType = WalletTypeEnum.PrivateKey;

    await this.initialize({ privateKey });

    return this;
  }

  // Initialize wallet from Wallet Import Format
  protected async fromWIF(privateKeyWif: string): Promise<this> {
    // initialize would make a random key for an empty one
    if (!privateKeyWif?.length) {
      throw Error("refusing to create wallet from empty WIF");
    }

    // @ts-ignore
    this.walletType = WalletTypeEnum.Wif;

    await this.initialize({ privateKeyWif });

    return this;
  }

  /**
   * newRandom (internal) if the wallet is named, get or create it; otherwise create a random
   * unnamed wallet
   * @param {string} name              name of the wallet
   */
  protected async newRandom(name: string): Promise<this> {
    if (name.length > 0) {
      return this.named(name);
    } else {
      return this.initialize();
    }
  }
  //#endregion Protected Implementations

  //#region Serialization
  /**
   * toDbString - store the serialized version of the wallet in the database, not just the name
   *
   * @throws {Error} if called on BaseWallet
   */
  public toDbString() {
    if (this.walletType == WalletTypeEnum.Seed) {
      return `${this.walletType}:${this.network}:${this.mnemonic}:${this.derivationPath}`;
    } else if (this.walletType == WalletTypeEnum.PrivateKey) {
      return `${this.walletType}:${this.network}:${binToHex(this.privateKey)}`;
    } else if (this.walletType === WalletTypeEnum.Wif) {
      return `${this.walletType}:${this.network}:${this.privateKeyWif}`;
    } else if (this.walletType == WalletTypeEnum.Watch) {
      return super.toDbString();
    }

    throw Error("toDbString unsupported wallet type");
  }
  //#endregion Serialization

  //#region Funds
  /**
   * sendMax Send all available funds to a destination cash address
   *
   * @param  {string} cashaddr destination cash address
   * @param  {SendRequestOptionsI} options Options of the send requests
   *
   * @returns the transaction id, the signed transaction and the token categories it spends or sends
   */
  public async sendMax(
    cashaddr: string,
    options?: SendRequestOptionsI,
  ): Promise<SendResponse> {
    return this.sendMaxRaw(cashaddr, options, this.privateKey);
  }

  /**
   * encodeTransaction Encode and sign a transaction given a list of sendRequests, options and estimate fees.
   * @param  {SendRequest[]} sendRequests SendRequests
   * @param  {boolean} discardChange=false
   * @param  {SendRequestOptionsI} options Options of the send requests
   */
  protected async encodeTransaction(
    requests:
      | SendRequest
      | TokenSendRequest
      | OpReturnData
      | Array<SendRequest | TokenSendRequest | OpReturnData>,
    discardChange: boolean = false,
    options?: SendRequestOptionsI,
    privateKey?: Uint8Array,
    tokenBurns?: TokenBurnAllowance,
  ) {
    privateKey = privateKey ?? this.privateKey;

    if (!privateKey) {
      throw new Error(`Missing private key`);
    }

    return super.encodeTransaction(
      requests,
      discardChange,
      options,
      privateKey,
      tokenBurns,
    );
  }

  //#endregion Funds
}

/**
 * Class to manage a testnet wallet.
 */
export class TestNetWallet extends Wallet {
  constructor(name = "") {
    super(name, NetworkType.Testnet);
  }
}

/**
 * Class to manage a regtest wallet.
 */
export class RegTestWallet extends Wallet {
  constructor(name = "") {
    super(name, NetworkType.Regtest);
  }
}
