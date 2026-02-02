/**
 * DIESEL Miner Configuration
 * 
 * Autonomous mining parameters and network endpoints.
 */

// ═══════════════════════════════════════════════════════════════
// MINING STRATEGY
// ═══════════════════════════════════════════════════════════════

/** Fee range for minting (sat/vB) - sweet spot per user testing */
export const MIN_FEE_RATE = 0.17;
export const MAX_FEE_RATE = 1.5;

/** Preferred fee rate band (where most profit is) */
export const PREFERRED_MIN_FEE = 0.17;
export const PREFERRED_MAX_FEE = 0.20;

/** Max unconfirmed TX chain length (Bitcoin mempool limit) */
export const MAX_CHAIN_LENGTH = 25;

/** Default mint count per cycle (will be optimized by strategy) */
export const DEFAULT_MINT_COUNT = 10;

/** Fixed vsize for a DIESEL mint TX (P2TR input + P2TR output + OP_RETURN) */
export const TX_VSIZE = 141;

/** DIESEL protocol fee deducted from block reward */
export const DIESEL_FEE = 0.05;

/** P2TR dust limit in sats */
export const DUST_LIMIT = 330;

/** Minimum wallet balance to continue mining (sats) */
export const MIN_BALANCE_SATS = 5000;

/** Auto-RBF: bump when effective rate drops below mempool × this factor */
export const RBF_BUFFER_FACTOR = 1.1;

/** Incremental relay fee for RBF (sat/vB) */
export const INCREMENTAL_RELAY_FEE = 1;

/** RBF sequence number */
export const RBF_SEQUENCE = 0xfffffffd;

// ═══════════════════════════════════════════════════════════════
// NETWORK ENDPOINTS
// ═══════════════════════════════════════════════════════════════

/** Subfrost RPC for broadcasting, Lua scripts, and UTXO queries */
export const RPC_URL = process.env.RPC_URL || 'https://mainnet.subfrost.io/v4/subfrost';

/** Mempool.space API for fee estimates */
export const MEMPOOL_API = 'https://mempool.space/api/v1/fees/mempool-blocks';
export const MEMPOOL_UTXO_API = 'https://mempool.space/api/address';
export const MEMPOOL_TX_API = 'https://mempool.space/api/tx';

/** Esplora API (fallback) */
export const ESPLORA_API = 'https://blockstream.info/api';

// ═══════════════════════════════════════════════════════════════
// TIMING
// ═══════════════════════════════════════════════════════════════

/** Main loop interval (ms) */
export const POLL_INTERVAL_MS = 12_000;

/** Competition scan interval (ms) */
export const COMPETITION_SCAN_INTERVAL_MS = 15_000;

/** Delay between broadcasting chained TXs (ms) */
export const BROADCAST_DELAY_MS = 500;

/** Wait after chain confirmation before starting new cycle (ms) */
export const POST_CONFIRM_DELAY_MS = 3_000;

/** Max retries for failed broadcasts */
export const MAX_BROADCAST_RETRIES = 3;

/** Retry delay (ms) */
export const RETRY_DELAY_MS = 2_000;

// ═══════════════════════════════════════════════════════════════
// DIESEL TOKEN
// ═══════════════════════════════════════════════════════════════

/** Known working OP_RETURN script for DIESEL mint (count=1) */
export const DIESEL_MINT_OP_RETURN = '6a5d1214011400ff7f818cec82d08bc0a88281d215';

/** DIESEL OP_RETURN prefix for competition scanning */
export const DIESEL_OP_RETURN_PREFIX = '6a5d1214011400';

/** Default block reward (DIESEL per block) */
export const DEFAULT_BLOCK_REWARD = 21;

/** Default DIESEL price in sats (updated at runtime from pool) */
export const DEFAULT_DIESEL_PRICE_SATS = 1000;

// ═══════════════════════════════════════════════════════════════
// WALLET (BIP86 P2TR)
// ═══════════════════════════════════════════════════════════════

/** BIP86 derivation path for taproot */
export const DERIVATION_PATH = "m/86'/0'/0'/0/0";

// ═══════════════════════════════════════════════════════════════
// LUA COMPETITION SCANNER
// ═══════════════════════════════════════════════════════════════

export const DIESEL_SCAN_LUA = `
local minFeeRate = tonumber(args[1]) or 1
local DIESEL_VSIZE = 141
local DIESEL_WEIGHT = 562

local mempool = _RPC.btc_getrawmempool(true)

local dieselCount = 0
local totalMempool = 0
local qualifying = 0

for txid, entry in pairs(mempool) do
  totalMempool = totalMempool + 1
  local ancestorFeeRate = (entry.fees.ancestor * 100000000) / entry.ancestorsize
  local descendantFeeRate = (entry.fees.descendant * 100000000) / entry.descendantsize
  local threshold = minFeeRate * 0.9
  if ancestorFeeRate >= threshold or descendantFeeRate >= threshold then
    qualifying = qualifying + 1
    -- DIESEL mints have a unique fingerprint: vsize=141, weight=562
    -- (P2TR input + P2TR output + OP_RETURN with DIESEL payload)
    if entry.vsize == DIESEL_VSIZE and entry.weight == DIESEL_WEIGHT then
      dieselCount = dieselCount + 1
    end
  end
end

return {
  total_mempool = totalMempool,
  qualifying = qualifying,
  diesel_mints = dieselCount
}
`;
