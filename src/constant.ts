export const DELIMITER = ":";

// Min amount utxo can be to be accepted by the network
export const DUST_UTXO_THRESHOLD = 546n;

// Bytes of OP_RETURN script a standard transaction may carry, summed over all its OP_RETURN
// outputs and counting each whole script (BCHN's -datacarriersize default)
export const MAX_OP_RETURN_BYTES = 223;

// Current chained tx limit
export const MEMPOOL_CHAIN_LIMIT = 50;

// time in milliseconds to cache the usd exchange rate
export const EXCHANGE_RATE_TTL = 250000;
