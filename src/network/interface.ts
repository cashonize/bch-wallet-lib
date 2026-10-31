import { NFTCapability } from "../interface.js";

export interface ElectrumTokenData {
  amount: string;
  category: string;
  nft?: {
    capability: NFTCapability;
    commitment: string;
  };
}

export interface ElectrumUtxo {
  tx_pos: number;
  value: number;
  tx_hash: string;
  height: number;
  token_data?: ElectrumTokenData;
}
