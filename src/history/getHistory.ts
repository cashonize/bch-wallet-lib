import {
  assertSuccess,
  binToHex,
  CashAddressNetworkPrefix,
  decodeCashAddress,
  decodeTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  Opcodes,
  TransactionCommon,
} from "@bitauth/libauth";
import { HeaderI, TxI, Utxo } from "../interface.js";
import ElectrumNetworkProvider from "../network/ElectrumNetworkProvider.js";
import { DEFAULT_CONCURRENCY, mapConcurrent } from "../util/mapConcurrent.js";
import { sumUtxoValue } from "../util/sumUtxoValue.js";
import { InOutput, TransactionHistoryItem } from "./interface.js";

// P2S, P2PK and bare multisig have no CashAddress; they get a placeholder like OP_RETURN outputs do
export const historyAddress = (
  lockingBytecode: Uint8Array,
  prefix: CashAddressNetworkPrefix,
): string => {
  const result = lockingBytecodeToCashAddress({
    bytecode: lockingBytecode,
    prefix,
  });
  if (typeof result === "string") {
    return `SCRIPT: ${binToHex(lockingBytecode)}`;
  }
  return result.address;
};

type Transaction = TransactionCommon & {
  size: number;
  blockHeight: number;
  timestamp?: number;
  hash: string;
};

export const getHistory = async ({
  addresses,
  provider,
  count = -1,
  rawHistory,
  utxos,
  concurrency = DEFAULT_CONCURRENCY,
}: {
  addresses: string[];
  provider: ElectrumNetworkProvider;
  /** The newest `count` items; default -1, all of them */
  count?: number;
  /** @internal The wallet's raw history of `addresses`, instead of fetching it */
  rawHistory?: TxI[];
  /** The current utxos of `addresses`, token coins included, which the running balances are backfilled from */
  utxos: Utxo[];
  /** Requests in flight at most, for each step of the load */
  concurrency?: number;
}): Promise<TransactionHistoryItem[]> => {
  if (!addresses.length) {
    return [];
  }

  if (count === -1) {
    count = 1e10;
  }

  let history: TxI[];
  if (rawHistory) {
    history = rawHistory.slice(0, count);
  } else {
    const allHistory = (
      await mapConcurrent(addresses, concurrency, (address) =>
        provider.getHistory(address),
      )
    ).flat();

    // Dedup using Set instead of O(N^2) findIndex
    const seen = new Set<string>();
    const deduped: TxI[] = [];
    for (const item of allHistory) {
      if (!seen.has(item.tx_hash)) {
        seen.add(item.tx_hash);
        deduped.push(item);
      }
    }

    history = deduped
      .sort((a, b) =>
        a.height <= 0 || b.height <= 0
          ? a.height - b.height
          : b.height - a.height,
      )
      .slice(0, count);
  }

  // Collect unique heights for header fetch
  const uniqueHeightsSet = new Set<number>();
  for (const tx of history) {
    if (tx.height > 0) uniqueHeightsSet.add(tx.height);
  }
  const uniqueHeights = [...uniqueHeightsSet];

  // one batch after the other, so that no more than `concurrency` requests are in flight
  const historyHashes = history.map((tx) => tx.tx_hash);
  const txHexMap = await provider.getRawTransactions(historyHashes, {
    concurrency,
  });
  let headerMap = new Map<number, HeaderI>();
  if (uniqueHeights.length > 0) {
    headerMap = await provider.getHeaders(uniqueHeights, { concurrency });
  }

  const timestampMap: Record<number, number> = {};
  for (const [height, header] of headerMap) {
    timestampMap[height] = header.timestamp;
  }

  // Precompute binToHex for each input's outpoint hash once
  const inputOutpointHashes = new WeakMap<Uint8Array, string>();
  const getOutpointHash = (bytes: Uint8Array): string => {
    let hash = inputOutpointHashes.get(bytes);
    if (hash === undefined) {
      hash = binToHex(bytes);
      inputOutpointHashes.set(bytes, hash);
    }
    return hash;
  };

  const historicTransactions = history.map((tx) => {
    const txHex = txHexMap.get(tx.tx_hash)!;
    const transactionCommon = decodeTransaction(hexToBin(txHex));
    if (typeof transactionCommon === "string") {
      throw new Error(transactionCommon);
    }

    const transaction = transactionCommon as Transaction;
    transaction.blockHeight = tx.height;
    transaction.timestamp = timestampMap[tx.height];
    transaction.hash = tx.tx_hash;
    transaction.size = txHex.length / 2;

    return transaction;
  });

  // Collect unique prevout hashes using Set, excluding already-fetched txs
  const ZERO_HASH =
    "0000000000000000000000000000000000000000000000000000000000000000";
  const prevoutHashSet = new Set<string>();
  for (const tx of historicTransactions) {
    for (const input of tx.inputs) {
      const hash = getOutpointHash(input.outpointTransactionHash);
      if (hash !== ZERO_HASH && !txHexMap.has(hash)) {
        prevoutHashSet.add(hash);
      }
    }
  }

  // Batch fetch prevout transactions
  const prevoutHashes = [...prevoutHashSet];
  const prevoutHexMap = await provider.getRawTransactions(prevoutHashes, {
    concurrency,
  });

  // Build prevout transaction map (decode all prevout txs)
  const prevoutTransactionMap: Record<string, TransactionCommon> = {};
  const allPrevoutSources = new Map([...txHexMap, ...prevoutHexMap]);
  for (const tx of historicTransactions) {
    for (const input of tx.inputs) {
      const hash = getOutpointHash(input.outpointTransactionHash);
      if (hash === ZERO_HASH || prevoutTransactionMap[hash]) continue;

      const hex = allPrevoutSources.get(hash);
      if (!hex) continue;

      const decoded = decodeTransaction(hexToBin(hex));
      if (typeof decoded === "string") {
        throw new Error(decoded);
      }
      prevoutTransactionMap[hash] = decoded;
    }
  }

  const decoded = assertSuccess(decodeCashAddress(addresses[0]));
  const prefix = decoded.prefix as CashAddressNetworkPrefix;

  const addressCache: Record<any, string> = {};
  const addressSet = new Set(addresses);

  // map decoded transaction data to TransactionHistoryItem
  const historyItems = historicTransactions.map((tx) => {
    const result = {} as TransactionHistoryItem;

    let inputTotalValue = 0n;
    let outputTotalValue = 0n;

    const isCoinbase =
      tx.inputs.length === 1 &&
      tx.inputs[0].outpointTransactionHash.every((b) => b === 0);

    result.inputs = tx.inputs.map((input): InOutput => {
      if (isCoinbase) {
        const halvings = Math.floor(tx.blockHeight / 210000);
        const subsidy = Math.floor(5000000000 / 2 ** halvings);
        inputTotalValue += BigInt(subsidy);

        return {
          address: "coinbase",
          value: subsidy,
        };
      }

      const prevoutTx =
        prevoutTransactionMap[getOutpointHash(input.outpointTransactionHash)];
      if (!prevoutTx) {
        throw new Error("Could not find prevout transaction");
      }

      const prevoutOutput = prevoutTx.outputs[input.outpointIndex];
      if (!prevoutOutput) {
        throw new Error("Could not find prevout output");
      }

      const cached = addressCache[prevoutOutput.lockingBytecode as any];
      let address: string;
      if (!cached) {
        address = historyAddress(prevoutOutput.lockingBytecode, prefix);
        addressCache[prevoutOutput.lockingBytecode as any] = address;
      } else {
        address = cached;
      }

      inputTotalValue += prevoutOutput.valueSatoshis;

      return {
        address: address,
        value: Number(prevoutOutput.valueSatoshis),
        token: prevoutOutput.token
          ? {
              category: binToHex(prevoutOutput.token.category),
              amount: prevoutOutput.token.amount,
              nft: prevoutOutput.token.nft
                ? {
                    capability: prevoutOutput.token.nft.capability,
                    commitment: binToHex(prevoutOutput.token.nft.commitment),
                  }
                : undefined,
            }
          : undefined,
        outpointTransactionHash: getOutpointHash(input.outpointTransactionHash),
        outpointIndex: input.outpointIndex,
        lockingBytecode: binToHex(prevoutOutput.lockingBytecode),
      };
    });

    result.outputs = tx.outputs.map((output): InOutput => {
      const cached = addressCache[output.lockingBytecode as any];
      let address: string;
      if (!cached) {
        if (output.lockingBytecode[0] === Opcodes.OP_RETURN) {
          address = `OP_RETURN: ${binToHex(output.lockingBytecode)}`;
        } else {
          address = historyAddress(output.lockingBytecode, prefix);
          addressCache[output.lockingBytecode as any] = address;
        }
      } else {
        address = cached;
      }

      outputTotalValue += output.valueSatoshis;

      return {
        address: address,
        value: Number(output.valueSatoshis),
        token: output.token
          ? {
              category: binToHex(output.token.category),
              amount: output.token.amount,
              nft: output.token.nft
                ? {
                    capability: output.token.nft.capability,
                    commitment: binToHex(output.token.nft.commitment),
                  }
                : undefined,
            }
          : undefined,
        lockingBytecode: binToHex(output.lockingBytecode),
      };
    });

    result.blockHeight = tx.blockHeight;
    result.timestamp = tx.timestamp;
    result.hash = tx.hash;
    result.size = tx.size;
    result.fee = Number(inputTotalValue - outputTotalValue);

    if (isCoinbase && result.fee) {
      // will indicate the fees collected by the miner
      result.fee = -result.fee;
    }

    return result;
  });

  // compute value changes using Set for O(1) address lookup
  historyItems.forEach((tx) => {
    let satoshiBalance = 0;
    const ftTokenBalances: Record<string, bigint> = {};
    const nftTokenBalances: Record<string, bigint> = {};

    tx.inputs.forEach((input) => {
      if (addressSet.has(input.address)) {
        satoshiBalance -= input.value;

        if (input.token?.amount) {
          ftTokenBalances[input.token.category] =
            (ftTokenBalances[input.token.category] || BigInt(0)) -
            input.token.amount;
        }

        if (input.token?.nft?.capability) {
          nftTokenBalances[input.token.category] =
            (nftTokenBalances[input.token.category] || BigInt(0)) - 1n;
        }
      }
    });
    tx.outputs.forEach((output) => {
      if (addressSet.has(output.address)) {
        satoshiBalance += Number(output.value);

        if (output.token?.amount) {
          ftTokenBalances[output.token.category] =
            (ftTokenBalances[output.token.category] || BigInt(0)) +
            output.token.amount;
        }

        if (output.token?.nft?.capability) {
          nftTokenBalances[output.token.category] =
            (nftTokenBalances[output.token.category] || BigInt(0)) + 1n;
        }
      }
    });

    tx.valueChange = satoshiBalance;
    tx.tokenAmountChanges = Object.entries(ftTokenBalances).map(
      ([category, amount]) => ({
        category,
        amount,
        nftAmount: BigInt(0),
      }),
    );

    for (const [category, nftAmount] of Object.entries(nftTokenBalances)) {
      const tokenChange = tx.tokenAmountChanges.find(
        (tokenChange) => tokenChange.category === category,
      );
      if (tokenChange) {
        tokenChange.nftAmount = nftAmount;
      } else {
        tx.tokenAmountChanges.push({
          category: category,
          amount: BigInt(0),
          nftAmount,
        });
      }
    }
  });

  // order transactions in a way such that receives are always ordered before sends, per block
  historyItems.sort(
    (a, b) =>
      (a.blockHeight <= 0 || b.blockHeight <= 0
        ? a.blockHeight - b.blockHeight
        : b.blockHeight - a.blockHeight) || a.valueChange - b.valueChange,
  );

  // backfill the balances from the current one, the satoshis of token coins included
  let prevBalance = Number(sumUtxoValue(utxos));

  let prevValueChange = 0;
  historyItems.forEach((tx) => {
    tx.balance = prevBalance - prevValueChange;
    prevBalance = tx.balance;
    prevValueChange = tx.valueChange;
  });

  return historyItems;
};
