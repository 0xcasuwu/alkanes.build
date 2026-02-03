/**
 * Strategy Module - Optimal DIESEL Minting Calculation
 * 
 * CORE INSIGHT: The amount we spend must be LESS than the BTC value we receive.
 * 
 * Revenue = (n / (M + n)) × block_reward × (1 - fee) × diesel_price
 * Cost = n × TX_VSIZE × fee_rate
 * 
 * We must ensure: Revenue > Cost (after applying competition buffer)
 * 
 * Formula for optimal n: n* = √(N* × M) - M
 * where N* = R × p / (2 × f)
 */

import {
  TX_VSIZE,
  DIESEL_FEE,
  MAX_CHAIN_LENGTH,
  DEFAULT_BLOCK_REWARD,
  DEFAULT_DIESEL_PRICE_SATS,
  MIN_FEE_RATE,
  MAX_FEE_RATE,
  PREFERRED_MIN_FEE,
  PREFERRED_MAX_FEE,
  COMPETITION_BUFFER,
  MIN_ROI_THRESHOLD,
} from './config.js';

export interface StrategyInput {
  /** Current mempool fee rate (sat/vB) */
  feeRate: number;
  /** Number of competing DIESEL mints in mempool (observed now) */
  competition: number;
  /** Block reward in DIESEL */
  blockReward: number;
  /** DIESEL price in satoshis */
  dieselPriceSats: number;
  /** Our current active chain length (0 if none) */
  activeChainLength: number;
  /** Our current effective fee rate (if active chain) */
  effectiveRate: number;
  /** Minimum fee for next block (from mempool) */
  minFeeForNextBlock: number;
  /** Is this within the mining window (waited long enough since last block)? */
  inMiningWindow: boolean;
}

export interface StrategyResult {
  /** Whether we should mine NOW */
  shouldMine: boolean;
  /** Optimal number of mints */
  optimalMints: number;
  /** Expected DIESEL emission for our mints */
  expectedEmission: number;
  /** Total cost in sats (what we spend on fees) */
  totalCostSats: number;
  /** Expected value in sats (what we get back) */
  expectedValueSats: number;
  /** Net profit in sats (value - cost) */
  netProfitSats: number;
  /** ROI percentage */
  roi: number;
  /** Whether profitable at buffered M */
  isProfitable: boolean;
  /** Reason for decision */
  reason: string;
  /** Current observed M */
  currentM: number;
  /** Buffered M used for calculation (pessimistic) */
  bufferedM: number;
  /** Whether we're in the mining window */
  inMiningWindow: boolean;
}

/**
 * Calculate optimal minting strategy
 * 
 * CORE RULE: Don't mine unless:
 *   expected_value_sats > cost_sats (at buffered M)
 *   ROI > MIN_ROI_THRESHOLD
 *   In mining window (waited long enough since last block)
 * 
 * The buffer accounts for other miners piling in after us.
 */
export function calculateStrategy(input: StrategyInput): StrategyResult {
  const {
    feeRate,
    competition,
    blockReward = DEFAULT_BLOCK_REWARD,
    dieselPriceSats = DEFAULT_DIESEL_PRICE_SATS,
    activeChainLength,
    effectiveRate,
    minFeeForNextBlock,
    inMiningWindow,
  } = input;

  const feeInRange = feeRate >= MIN_FEE_RATE && feeRate <= MAX_FEE_RATE;
  const feeInPreferredRange = feeRate >= PREFERRED_MIN_FEE && feeRate <= PREFERRED_MAX_FEE;

  // Subtract our chain from M if we're already competing
  const weAreCompeting = effectiveRate >= minFeeForNextBlock;
  const chainToSubtract = weAreCompeting ? activeChainLength : 0;
  const currentM = Math.max(0, competition - chainToSubtract);

  // Apply competition buffer - assume M will grow before block confirms
  // This is pessimistic: if we're profitable at bufferedM, we're definitely
  // profitable if fewer miners show up
  const bufferedM = Math.ceil(currentM * COMPETITION_BUFFER);

  // Pool after protocol fee (what's actually distributed)
  const pool = blockReward * (1 - DIESEL_FEE);

  // Cost per mint in sats
  const costPerMint = Math.ceil(feeRate * TX_VSIZE);

  // N* = R × p / (2 × f) — theoretical break-even point
  const nStar = (blockReward * dieselPriceSats) / (2 * costPerMint);

  // Optimal mints: n* = √(N* × M) - M
  // Use bufferedM for conservative estimate
  const rawOptimal = bufferedM > 0 ? Math.sqrt(nStar * bufferedM) - bufferedM : nStar;
  
  // Cap at available slots
  const availableSlots = MAX_CHAIN_LENGTH - activeChainLength;
  let optimalMints = Math.min(Math.max(0, Math.floor(rawOptimal)), availableSlots);

  // Calculate expected returns at buffered M
  // Our share: n / (bufferedM + n)
  // Value: share × pool × price
  const totalMiners = bufferedM + optimalMints;
  const ourShare = totalMiners > 0 ? optimalMints / totalMiners : 0;
  const expectedEmission = ourShare * pool;
  const expectedValueSats = expectedEmission * dieselPriceSats;
  const totalCostSats = optimalMints * costPerMint;
  const netProfitSats = expectedValueSats - totalCostSats;
  const roi = totalCostSats > 0 ? (netProfitSats / totalCostSats) * 100 : 0;

  // Core profitability check: value > cost
  const isProfitable = expectedValueSats > totalCostSats && roi >= MIN_ROI_THRESHOLD;

  // If not profitable at current optimal, try fewer mints
  if (!isProfitable && optimalMints > 1) {
    // Maybe fewer mints is profitable
    for (let n = optimalMints - 1; n >= 1; n--) {
      const testShare = n / (bufferedM + n);
      const testValue = testShare * pool * dieselPriceSats;
      const testCost = n * costPerMint;
      const testRoi = (testValue - testCost) / testCost * 100;
      if (testValue > testCost && testRoi >= MIN_ROI_THRESHOLD) {
        optimalMints = n;
        break;
      }
    }
  }

  // Recalculate with final optimalMints
  const finalTotalMiners = bufferedM + optimalMints;
  const finalShare = finalTotalMiners > 0 ? optimalMints / finalTotalMiners : 0;
  const finalEmission = finalShare * pool;
  const finalValueSats = finalEmission * dieselPriceSats;
  const finalCostSats = optimalMints * costPerMint;
  const finalNetProfitSats = finalValueSats - finalCostSats;
  const finalRoi = finalCostSats > 0 ? (finalNetProfitSats / finalCostSats) * 100 : 0;
  const finalProfitable = finalValueSats > finalCostSats && finalRoi >= MIN_ROI_THRESHOLD;

  // Decision logic
  let shouldMine = false;
  let reason = '';

  if (!feeInRange) {
    reason = feeRate < MIN_FEE_RATE
      ? `Fee ${feeRate.toFixed(3)} below min ${MIN_FEE_RATE}`
      : `Fee ${feeRate.toFixed(3)} above max ${MAX_FEE_RATE}`;
  } else if (optimalMints <= 0) {
    reason = `No profitable mints at M=${currentM}→${bufferedM}`;
  } else if (!finalProfitable) {
    reason = `Not profitable: cost ${finalCostSats} sats > value ${Math.round(finalValueSats)} sats (M=${currentM}→${bufferedM})`;
  } else if (availableSlots <= 0) {
    reason = `Chain full (${MAX_CHAIN_LENGTH})`;
  } else if (!inMiningWindow) {
    // Profitable but too early - wait for mining window
    reason = `WAIT: profitable (${finalRoi.toFixed(0)}% ROI) but too early - M may grow`;
  } else {
    shouldMine = true;
    const tag = feeInPreferredRange ? 'OPTIMAL' : 'OK';
    reason = `${tag}: ${optimalMints} mints, cost ${finalCostSats} < value ${Math.round(finalValueSats)} sats (${finalRoi.toFixed(0)}% ROI, M=${currentM}→${bufferedM})`;
  }

  return {
    shouldMine,
    optimalMints,
    expectedEmission: finalEmission,
    totalCostSats: finalCostSats,
    expectedValueSats: finalValueSats,
    netProfitSats: finalNetProfitSats,
    roi: finalRoi,
    isProfitable: finalProfitable,
    reason,
    currentM,
    bufferedM,
    inMiningWindow,
  };
}

/**
 * Calculate whether auto-RBF should trigger
 */
export function shouldAutoRbf(
  effectiveRate: number,
  currentMempoolRate: number,
  hasActiveChain: boolean,
  bufferFactor: number = 1.1,
): { shouldRbf: boolean; targetRate: number; reason: string } {
  if (!hasActiveChain || effectiveRate <= 0) {
    return { shouldRbf: false, targetRate: 0, reason: 'No active chain' };
  }

  const targetRate = currentMempoolRate * bufferFactor;
  
  if (effectiveRate >= targetRate) {
    return {
      shouldRbf: false,
      targetRate,
      reason: `Rate OK: ${effectiveRate.toFixed(3)} >= ${targetRate.toFixed(3)}`,
    };
  }

  return {
    shouldRbf: true,
    targetRate,
    reason: `Rate low: ${effectiveRate.toFixed(3)} < ${targetRate.toFixed(3)} → bumping`,
  };
}
