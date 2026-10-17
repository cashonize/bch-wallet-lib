import { binToHex, Output } from "@bitauth/libauth";
import { NFTCapability, Utxo } from "../interface.js";
import { TokenBurnError } from "../wallet/errors.js";

/** What a transaction may destroy of the tokens its inputs carry: nothing unless listed. */
export interface TokenBurnAllowance {
  /** per category, the fungible amount that may be destroyed */
  fungible?: Record<string, bigint>;
  /** NFTs that may be destroyed, any number of each */
  nfts?: Array<{
    category: string;
    capability: NFTCapability;
    commitment: string;
  }>;
}

type Nft = { capability: NFTCapability; commitment: string };

/**
 * checkTokenConservation - throws a TokenBurnError when the outputs lack tokens the inputs carry
 * beyond what `allowed` lets the transaction destroy
 *
 * Per category the fungible amount must come back in full, and every NFT input must reappear: as
 * the same NFT, or as an NFT the CashTokens rules let it become, i.e. a minting NFT as another
 * minting NFT, and, when no minting NFT of the category is spent, a mutable NFT as another
 * non-minting NFT. With a minting input spent, a new NFT is a mint, so the other NFTs must come
 * back as they were. Tokens created from nothing are left to libauth's consensus check.
 */
export function checkTokenConservation(
  inputs: Utxo[],
  outputs: Output[],
  allowed: TokenBurnAllowance,
): void {
  const categories = inputs
    .filter((input) => input.token)
    .map((input) => input.token!.category)
    .filter((val, idx, arr) => arr.indexOf(val) === idx);

  for (const category of categories) {
    const categoryInputs = inputs.filter(
      (input) => input.token?.category === category,
    );
    const categoryOutputs = outputs.filter(
      (output) => output.token && binToHex(output.token.category) === category,
    );

    const inputAmount = categoryInputs.reduce(
      (sum, input) => sum + input.token!.amount,
      0n,
    );
    const outputAmount = categoryOutputs.reduce(
      (sum, output) => sum + output.token!.amount,
      0n,
    );
    const missing =
      inputAmount - outputAmount - (allowed.fungible?.[category] ?? 0n);
    if (missing > 0n) {
      throw new TokenBurnError(
        `The transaction would burn ${missing} fungible tokens of category ${category}`,
        { category, amount: missing },
      );
    }

    const inputNfts: Nft[] = categoryInputs
      .filter((input) => input.token!.nft)
      .map((input) => ({
        capability: input.token!.nft!.capability,
        commitment: input.token!.nft!.commitment ?? "",
      }));
    const remainingOutputs: Nft[] = categoryOutputs
      .filter((output) => output.token!.nft)
      .map((output) => ({
        capability: output.token!.nft!.capability,
        commitment: binToHex(output.token!.nft!.commitment),
      }));
    const take = (match: (nft: Nft) => boolean) => {
      const index = remainingOutputs.findIndex(match);
      if (index === -1) return false;
      remainingOutputs.splice(index, 1);
      return true;
    };

    // the NFTs that come back as they were are matched first, so that a changed one cannot take
    // an output another input needs
    const unmatched = inputNfts.filter(
      (nft) =>
        !take(
          (out) =>
            out.capability === nft.capability &&
            out.commitment === nft.commitment,
        ),
    );
    const mintingSpent = inputNfts.some(
      (nft) => nft.capability === NFTCapability.minting,
    );
    for (const nft of unmatched) {
      if (
        nft.capability === NFTCapability.minting &&
        take((out) => out.capability === NFTCapability.minting)
      ) {
        continue;
      }
      if (
        nft.capability === NFTCapability.mutable &&
        !mintingSpent &&
        take((out) => out.capability !== NFTCapability.minting)
      ) {
        continue;
      }
      const burnAllowed = allowed.nfts?.some(
        (val) =>
          val.category === category &&
          val.capability === nft.capability &&
          val.commitment === nft.commitment,
      );
      if (burnAllowed) continue;
      throw new TokenBurnError(
        `The transaction would burn a ${nft.capability} NFT of category ${category} with commitment "${nft.commitment}"`,
        {
          category,
          amount: 0n,
          nft: { capability: nft.capability, commitment: nft.commitment },
        },
      );
    }
  }
}
