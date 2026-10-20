// Shared by generate.mjs and rollback.mjs: the wallets a Cashonize user has, an offline chain that
// gives them history, and IndexedDB / localStorage dumps. Test keys only: BIP39 test vectors and the
// private keys 1, 2 and 3.
import {
  binToHex,
  cashAddressToLockingBytecode,
  deriveHdPath,
  deriveHdPathRelative,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  encodeCashAddress,
  encodeHdPublicKey,
  encodePrivateKeyWif,
  encodeTransaction,
  hash160,
  hash256,
  hexToBin,
  secp256k1,
  sha256,
  utf8ToBin,
} from "@bitauth/libauth";

export const MNEMONIC_ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const MNEMONIC_LEGAL =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
export const MNEMONIC_LETTER =
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
export const MNEMONIC_ZOO = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
export const MNEMONIC_ABANDON_24 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

// Cashonize's derivation paths (walletUtils.ts DERIVATION_PATHS)
export const STANDARD = "m/44'/145'/0'";
export const BITCOINDOTCOM = "m/44'/0'/0'";

export const NETWORKS = [
  { network: "mainnet", prefix: "bitcoincash", dbName: "bitcoincash" },
  { network: "testnet", prefix: "bchtest", dbName: "bchtest" },
];

const keyBytes = (n) => {
  const key = new Uint8Array(32);
  key[31] = n;
  return key;
};

function p2pkh(publicKeyCompressed, prefix, withTokens = false) {
  return encodeCashAddress({
    prefix,
    type: withTokens ? "p2pkhWithTokens" : "p2pkh",
    payload: hash160(publicKeyCompressed),
  }).address;
}

function keyAddress(n, prefix) {
  return p2pkh(secp256k1.derivePublicKeyCompressed(keyBytes(n)), prefix);
}

export function hdAddress(mnemonic, parent, path, prefix) {
  const node = deriveHdPathRelative(
    deriveHdPath(deriveHdPrivateNodeFromBip39Mnemonic(mnemonic), parent),
    path,
  );
  return p2pkh(secp256k1.derivePublicKeyCompressed(node.privateKey), prefix);
}

function xPubOf(mnemonic, parent, network) {
  const node = deriveHdPath(
    deriveHdPrivateNodeFromBip39Mnemonic(mnemonic),
    parent,
  );
  return encodeHdPublicKey({ node: deriveHdPublicNode(node), network })
    .hdPublicKey;
}

/// The wallets of one network, as Cashonize stores them (named in both databases), with the
/// addresses the fake chain gives history; `tokens` puts a token coin on that address
export function walletSpecs({ network, prefix }) {
  return [
    {
      // createNewWallet and importWallet store the same seed id
      name: "wallet 1",
      kind: "single",
      walletId: `seed:${network}:${MNEMONIC_ABANDON}:${STANDARD}/0/0`,
      used: [{ address: hdAddress(MNEMONIC_ABANDON, STANDARD, "0/0", prefix) }],
    },
    {
      name: "imported seed",
      kind: "single",
      walletId: `seed:${network}:${MNEMONIC_LEGAL}:${BITCOINDOTCOM}/0/0`,
      used: [
        { address: hdAddress(MNEMONIC_LEGAL, BITCOINDOTCOM, "0/0", prefix) },
      ],
    },
    {
      name: "wif wallet",
      kind: "single",
      walletId: `wif:${network}:${encodePrivateKeyWif(keyBytes(1), network)}`,
      used: [{ address: keyAddress(1, prefix), tokens: true }],
    },
    {
      name: "privkey wallet",
      kind: "single",
      walletId: `privkey:${network}:${binToHex(keyBytes(2))}`,
      used: [],
    },
    {
      name: "watch wallet",
      kind: "single",
      walletId: `watch:${network}:${keyAddress(3, prefix)}`,
      used: [{ address: keyAddress(3, prefix) }],
    },
    {
      // createNewHDWallet stores toDbString() of a fresh wallet, importHDWallet the same form
      name: "hd 1",
      kind: "hd",
      walletId: `hd:${network}:${MNEMONIC_LETTER}:${STANDARD}:0:0`,
      used: [
        { address: hdAddress(MNEMONIC_LETTER, STANDARD, "0/0", prefix) },
        {
          address: hdAddress(MNEMONIC_LETTER, STANDARD, "0/1", prefix),
          tokens: true,
        },
        {
          address: hdAddress(MNEMONIC_LETTER, STANDARD, "0/2", prefix),
          spent: true,
        },
        { address: hdAddress(MNEMONIC_LETTER, STANDARD, "1/0", prefix) },
      ],
    },
    {
      name: "hd imported",
      kind: "hd",
      walletId: `hd:${network}:${MNEMONIC_ABANDON_24}:${STANDARD}:0:0`,
      used: [
        { address: hdAddress(MNEMONIC_ABANDON_24, STANDARD, "0/0", prefix) },
      ],
    },
    {
      // mainnet-js's own default path, which Cashonize overrides; index 19 makes discovery
      // extend past the first gap
      name: "hd default path",
      kind: "hd",
      walletId: `hd:${network}:${MNEMONIC_ZOO}:${BITCOINDOTCOM}:0:0`,
      used: [
        { address: hdAddress(MNEMONIC_ZOO, BITCOINDOTCOM, "0/0", prefix) },
        { address: hdAddress(MNEMONIC_ZOO, BITCOINDOTCOM, "0/19", prefix) },
        { address: hdAddress(MNEMONIC_ZOO, BITCOINDOTCOM, "1/3", prefix) },
      ],
    },
    {
      // watch-only HD, from an account xpub
      name: "hd watch",
      kind: "hd",
      walletId: `hd:${network}:${xPubOf(MNEMONIC_LEGAL, STANDARD, network)}:0:0`,
      used: [{ address: hdAddress(MNEMONIC_LEGAL, STANDARD, "0/0", prefix) }],
    },
    {
      // nodes deeper than an account, which 3.1.7 stores as given (fromId, then replaceNamed)
      // and derives `branch/index` below like any other node
      name: "hd depth 4",
      kind: "hd",
      walletId: `hd:${network}:${MNEMONIC_LEGAL}:${STANDARD}/0:0:0`,
      used: [
        { address: hdAddress(MNEMONIC_LEGAL, `${STANDARD}/0`, "0/0", prefix) },
        { address: hdAddress(MNEMONIC_LEGAL, `${STANDARD}/0`, "1/0", prefix) },
      ],
    },
    {
      name: "hd watch depth 4",
      kind: "hd",
      walletId: `hd:${network}:${xPubOf(MNEMONIC_LETTER, `${BITCOINDOTCOM}/0`, network)}:0:0`,
      used: [
        {
          address: hdAddress(
            MNEMONIC_LETTER,
            `${BITCOINDOTCOM}/0`,
            "0/1",
            prefix,
          ),
        },
      ],
    },
    {
      name: "hd depth 5",
      kind: "hd",
      walletId: `hd:${network}:${MNEMONIC_ABANDON}:${STANDARD}/0/0:0:0`,
      used: [
        {
          address: hdAddress(
            MNEMONIC_ABANDON,
            `${STANDARD}/0/0`,
            "0/0",
            prefix,
          ),
        },
      ],
    },
  ];
}

const HEIGHT = 900000;

function fakeHeader(height) {
  // 80 bytes: version, previous hash, merkle root, time, bits, nonce
  const header = new Uint8Array(80);
  header[0] = 2;
  header.set(sha256.hash(utf8ToBin(`prev-${height}`)), 4);
  header.set(sha256.hash(utf8ToBin(`merkle-${height}`)), 36);
  new DataView(header.buffer).setUint32(68, 1700000000 + height, true);
  new DataView(header.buffer).setUint32(72, 0x1d00ffff, true);
  return { height, hex: binToHex(header) };
}

function payingTransaction(address, satoshis, seed) {
  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === "string") throw new Error(locking);
  const encoded = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: sha256.hash(utf8ToBin(seed)),
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: new Uint8Array(),
      },
    ],
    outputs: [{ lockingBytecode: locking.bytecode, valueSatoshis: satoshis }],
  });
  return {
    hex: binToHex(encoded),
    txid: binToHex(hash256(encoded).reverse()),
  };
}

/// Electrum's address status: sha256 of `tx_hash:height:` over the history
function electrumStatus(history) {
  if (history.length === 0) return null;
  const text = history.map((tx) => `${tx.tx_hash}:${tx.height}:`).join("");
  return binToHex(sha256.hash(utf8ToBin(text)));
}

/// What the fake server knows of one network: per address its history and utxos, the raw
/// transactions and the tip
export function buildChain(networkInfo) {
  const addresses = {};
  const transactions = {};
  const used = walletSpecs(networkInfo).flatMap((spec) => spec.used);
  used.forEach(({ address, tokens, spent }, i) => {
    const height = HEIGHT - 100 + i;
    const funding = payingTransaction(
      address,
      BigInt(10000 + i),
      `${address}-funding`,
    );
    transactions[funding.txid] = funding.hex;
    const history = [{ tx_hash: funding.txid, height }];
    const utxos = [];
    if (spent) {
      const spending = payingTransaction(address, 1n, `${address}-spending`);
      transactions[spending.txid] = spending.hex;
      // a mempool transaction, as electrum reports it
      history.push({ tx_hash: spending.txid, height: 0, fee: 226 });
    } else {
      utxos.push({
        tx_hash: funding.txid,
        tx_pos: 0,
        value: 10000 + i,
        height,
      });
    }
    if (tokens) {
      const tokenTx = payingTransaction(address, 1000n, `${address}-token`);
      transactions[tokenTx.txid] = tokenTx.hex;
      history.push({ tx_hash: tokenTx.txid, height: height + 1 });
      utxos.push({
        tx_hash: tokenTx.txid,
        tx_pos: 0,
        value: 1000,
        height: height + 1,
        token_data: {
          amount: "1000",
          category: binToHex(sha256.hash(utf8ToBin(`category-${address}`))),
          nft: { capability: "minting", commitment: "abcd" },
        },
      });
    }
    addresses[address] = { status: electrumStatus(history), history, utxos };
  });
  return {
    height: HEIGHT,
    header: fakeHeader(HEIGHT),
    addresses,
    transactions,
  };
}

/// Answers an electrum request from the chain, the way Fulcrum would
export function answer(chain, method, params) {
  const [first, fromHeight = 0] = params;
  switch (method) {
    case "blockchain.address.subscribe":
      return chain.addresses[first]?.status ?? null;
    case "blockchain.address.listunspent":
      return structuredClone(chain.addresses[first]?.utxos ?? []);
    case "blockchain.address.get_history":
      return structuredClone(
        (chain.addresses[first]?.history ?? []).filter(
          (tx) => tx.height <= 0 || tx.height >= fromHeight,
        ),
      );
    case "blockchain.address.get_balance":
      return {
        confirmed: (chain.addresses[first]?.utxos ?? []).reduce(
          (sum, utxo) => sum + utxo.value,
          0,
        ),
        unconfirmed: 0,
      };
    case "blockchain.headers.subscribe":
      return chain.header;
    case "blockchain.header.get":
      return first === chain.height ? chain.header : fakeHeader(first);
    case "blockchain.transaction.get": {
      const hex = chain.transactions[first];
      if (!hex) {
        throw new Error("No such mempool or blockchain transaction.");
      }
      if (!params[1]) return hex;
      return {
        txid: first,
        hash: first,
        hex,
        version: 2,
        size: hex.length / 2,
        locktime: 0,
        vin: [],
        vout: [],
        confirmations: 10,
        blockhash: binToHex(sha256.hash(utf8ToBin(`block-${first}`))),
        time: 1700000000,
        blocktime: 1700000000,
      };
    }
    case "blockchain.relayfee":
      return 0.00001;
    case "server.ping":
      return null;
    default:
      throw new Error(`fake electrum: unsupported method ${method}`);
  }
}

/// The electrum-cash client mainnet-js 3.1.7's ElectrumNetworkProvider drives
export class FakeElectrumClient {
  constructor(chain) {
    this.chain = chain;
    this.handlers = new Set();
    this.status = 1;
    this.chainHeight = chain.height;
  }
  async connect() {}
  async disconnect() {
    return true;
  }
  on(event, handler) {
    if (event === "notification") this.handlers.add(handler);
  }
  off(event, handler) {
    this.handlers.delete(handler);
  }
  async request(method, ...params) {
    return answer(this.chain, method, params);
  }
  async subscribe(method, ...params) {
    // electrum-cash sends the current status as a notification before subscribe resolves
    const result = answer(this.chain, method, params);
    for (const handler of this.handlers) {
      handler({ method, params: [...params, result] });
    }
  }
  async unsubscribe() {}
}

/// The Transport bch-wallet-lib's ElectrumNetworkProvider drives
export class FakeTransport {
  constructor(chain) {
    this.chain = chain;
  }
  async connect() {}
  async close() {}
  async request(method, params = []) {
    return answer(this.chain, method, params);
  }
  async subscribe(method, params, onData) {
    onData([...params, answer(this.chain, method, params)]);
    return async () => {};
  }
}

/// The DOMException an IndexedDB request failed with, or an Error when it has none
function toError(error, message) {
  if (error instanceof Error) return error;
  return new Error(message);
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(toError(req.error, "The IndexedDB request failed"));
  });
}

/// Every IndexedDB database with its version, stores and records, sorted by name
export async function dumpIndexedDB() {
  const databases = (await indexedDB.databases()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const dump = [];
  for (const { name, version } of databases) {
    const db = await request(indexedDB.open(name));
    const stores = [];
    for (const storeName of [...db.objectStoreNames].sort((a, b) =>
      a.localeCompare(b),
    )) {
      const store = db.transaction(storeName).objectStore(storeName);
      const keys = await request(store.getAllKeys());
      const values = await request(store.getAll());
      stores.push({
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: [...store.indexNames],
        records: keys.map((key, i) => ({ key, value: values[i] })),
      });
    }
    db.close();
    dump.push({ name, version, stores });
  }
  return dump;
}

/// Creates the dumped databases, at their versions, with their records
export async function loadIndexedDB(dump) {
  for (const { name, version, stores } of dump) {
    const open = indexedDB.open(name, version);
    open.onupgradeneeded = () => {
      for (const store of stores) {
        const options = { autoIncrement: store.autoIncrement };
        if (store.keyPath !== null) options.keyPath = store.keyPath;
        open.result.createObjectStore(store.name, options);
      }
    };
    const db = await request(open);
    for (const store of stores) {
      const tx = db.transaction(store.name, "readwrite");
      const objectStore = tx.objectStore(store.name);
      for (const { key, value } of store.records) {
        if (store.keyPath === null) objectStore.put(value, key);
        else objectStore.put(value);
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () =>
          reject(toError(tx.error, "The IndexedDB transaction failed"));
      });
    }
    db.close();
  }
}

export async function deleteAllIndexedDB() {
  for (const { name } of await indexedDB.databases()) {
    await request(indexedDB.deleteDatabase(name));
  }
}

export function dumpLocalStorage() {
  const entries = {};
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  for (const key of keys.sort((a, b) => a.localeCompare(b)))
    entries[key] = localStorage.getItem(key);
  return entries;
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { hexToBin };
