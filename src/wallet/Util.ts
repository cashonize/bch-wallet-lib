import {
  binToHex,
  decodeTransaction as decodeTransactionLibAuth,
  hexToBin,
  isPayToPublicKey,
  Transaction as LibAuthTransaction,
  lockingBytecodeToAddressContents,
  Opcodes,
  publicKeyToP2pkhCashAddress,
} from "@bitauth/libauth";
import { bchParam } from "../chain.js";
import { NetworkType, prefixFromNetworkMap } from "../enum.js";
import { historyAddress } from "../history/getHistory.js";
import { Network } from "../interface.js";
import { getNetworkProvider } from "../network/default.js";
import ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";
import {
  ElectrumRawTransaction,
  ElectrumRawTransactionVin,
  ElectrumRawTransactionVinWithValues,
  ElectrumRawTransactionVout,
  ElectrumRawTransactionWithInputValues,
} from "../network/interface.js";
import { DEFAULT_CONCURRENCY, mapConcurrent } from "../util/mapConcurrent.js";
import { getTransactionHash } from "../util/transaction.js";

export { getTransactionHash };

// P2PK keeps the P2PKH address of its key; scripts without an address get getHistory's placeholders
function outputAddress(lockingBytecode: Uint8Array, network: Network): string {
  const prefix = prefixFromNetworkMap[network];
  if (lockingBytecode[0] === Opcodes.OP_RETURN) {
    return `OP_RETURN: ${binToHex(lockingBytecode)}`;
  }
  if (isPayToPublicKey(lockingBytecode)) {
    return publicKeyToP2pkhCashAddress({
      publicKey: lockingBytecodeToAddressContents(lockingBytecode).payload,
      prefix,
    }).address;
  }
  return historyAddress(lockingBytecode, prefix);
}

function mapToElectrumRawTransaction(
  transaction: LibAuthTransaction,
  txHash: string,
  txHex: string,
  network: Network,
): ElectrumRawTransaction {
  return {
    blockhash: "",
    blocktime: 0,
    confirmations: 0,
    time: 0,
    hash: txHash,
    hex: txHex,
    txid: txHash,
    locktime: transaction.locktime,
    version: transaction.version,
    size: txHex.length / 2,
    vin: transaction.inputs.map((input): ElectrumRawTransactionVin => ({
      scriptSig: {
        asm: "",
        hex: binToHex(input.unlockingBytecode),
      },
      sequence: input.sequenceNumber,
      txid: binToHex(input.outpointTransactionHash),
      vout: input.outpointIndex,
    })),
    vout: transaction.outputs.map(
      (output, index): ElectrumRawTransactionVout => ({
        n: index,
        scriptPubKey: {
          addresses: [outputAddress(output.lockingBytecode, network)],
          asm: "",
          hex: binToHex(output.lockingBytecode),
          reqSigs: 1,
          type: "",
        },
        value: Number(output.valueSatoshis) / Number(bchParam.subUnits),
        ...(output.token && {
          tokenData: {
            amount: output.token.amount.toString(),
            category: binToHex(output.token.category),
            ...(output.token.nft && {
              nft: {
                capability: output.token.nft.capability,
                commitment: binToHex(output.token.nft.commitment),
              },
            }),
          },
        }),
      }),
    ),
  };
}

export interface DecodeTransactionOptions {
  /** The provider to fetch the transaction (and its inputs') from; default the network's global provider */
  provider?: ElectrumNetworkProvider;
}

export async function decodeTransaction(
  transactionHashOrHex: string,
  loadInputValues: true,
  network?: NetworkType,
  options?: DecodeTransactionOptions,
): Promise<ElectrumRawTransactionWithInputValues>;
export async function decodeTransaction(
  transactionHashOrHex: string,
  loadInputValues?: false,
  network?: NetworkType,
  options?: DecodeTransactionOptions,
): Promise<ElectrumRawTransaction>;
export async function decodeTransaction(
  transactionHashOrHex: string,
  loadInputValues?: boolean,
  network?: NetworkType,
  options?: DecodeTransactionOptions,
): Promise<ElectrumRawTransaction | ElectrumRawTransactionWithInputValues>;
export async function decodeTransaction(
  transactionHashOrHex: string,
  loadInputValues: boolean = false,
  network?: NetworkType,
  options: DecodeTransactionOptions = {},
): Promise<ElectrumRawTransaction | ElectrumRawTransactionWithInputValues> {
  let decodeNetwork: Network = network ?? NetworkType.Mainnet;
  if (options.provider) {
    if (network !== undefined && network !== options.provider.network) {
      throw new Error(
        `decodeTransaction: network ${network} does not match the provider's network ${options.provider.network}`,
      );
    }
    decodeNetwork = options.provider.network;
  }
  // looked up only when something is fetched, so decoding a hex creates no provider
  const getProvider = () =>
    options.provider ?? getNetworkProvider(decodeNetwork);
  let transactionHex: string;
  let transactionBin: Uint8Array;
  let txHash: string;

  if (transactionHashOrHex.length > 64) {
    txHash = await getTransactionHash(transactionHashOrHex);
    transactionBin = hexToBin(transactionHashOrHex);
    transactionHex = transactionHashOrHex;
  } else {
    txHash = transactionHashOrHex;
    transactionHex = await getProvider().getRawTransaction(txHash);
    transactionBin = hexToBin(transactionHex);
  }

  const result = decodeTransactionLibAuth(transactionBin);
  if (typeof result === "string") {
    throw Error(result);
  }

  const transaction = mapToElectrumRawTransaction(
    result,
    txHash,
    transactionHex,
    decodeNetwork,
  );

  if (loadInputValues) {
    const provider = getProvider();
    const hashes = [...new Set(transaction.vin.map((val) => val.txid))];
    const transactions = await mapConcurrent(
      hashes,
      DEFAULT_CONCURRENCY,
      (hash) => decodeTransaction(hash, false, undefined, { provider }),
    );
    const transactionMap = new Map<string, ElectrumRawTransaction>();
    transactions.forEach((val) => transactionMap.set(val.hash, val));

    const enrichedVin: ElectrumRawTransactionVinWithValues[] =
      transaction.vin.map((input) => {
        const output = transactionMap
          .get(input.txid)!
          .vout.find((val) => val.n === input.vout)!;
        return { ...input, ...output };
      });

    return { ...transaction, vin: enrichedVin };
  }

  return transaction;
}
