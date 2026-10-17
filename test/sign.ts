import {
  decodeTransaction,
  encodeTransaction,
  generateTransaction,
  hexToBin,
  importWalletTemplate,
  Input,
  Output,
  TransactionTemplateFixed,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBch,
} from "@bitauth/libauth";

/**
 * Signs every input of a hand-built transaction with one key's P2PKH unlock, for tests that need a
 * transaction the wallet's own sends do not build (P2S or bare outputs, OP_RETURN placement).
 */
export function signP2pkhInputs(
  transaction: Uint8Array | string,
  sourceOutputs: Array<Input & Output>,
  signingKey: Uint8Array,
): Uint8Array {
  if (typeof transaction === "string") {
    transaction = hexToBin(transaction);
  }
  const decoded = decodeTransaction(transaction);
  if (typeof decoded === "string") {
    throw new Error(decoded);
  }
  const template = importWalletTemplate(walletTemplateP2pkhNonHd);
  if (typeof template === "string") {
    throw new Error(template);
  }
  const compiler = walletTemplateToCompilerBch(template);
  const transactionTemplate: TransactionTemplateFixed<typeof compiler> = {
    ...decoded,
  };
  for (const [index, input] of decoded.inputs.entries()) {
    const sourceOutput = sourceOutputs[index];
    transactionTemplate.inputs[index] = {
      ...input,
      unlockingBytecode: {
        compiler,
        data: { keys: { privateKeys: { key: signingKey } } },
        valueSatoshis: sourceOutput.valueSatoshis,
        script: "unlock",
        token: sourceOutput.token,
      },
    };
  }
  const result = generateTransaction(transactionTemplate);
  if (!result.success) {
    throw new Error("Could not sign the transaction", { cause: result.errors });
  }
  return encodeTransaction(result.transaction);
}
