/**
 * Strategy Module - Optimal DIESEL Minting Calculation
 * 
 * Implements the formula: n* = √(N* × M) - M
 * where N* = R × p / (2 × f)
 * 
 * R = block reward in DIESEL
 * p = DIESEL price in sats
 * f = TX cost in sats
 * M = competing mints
 * n* = optimal number of our mints
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
} from './config.js';

export interface StrategyInput {
  /** Current mempool fee rate (sat/vB) */
  feeRate: number;
  /** Number of competing DIESEL mints in mempool */
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
}

export interface StrategyResult {
  /** Whether we should mine */
  shouldMine: boolean;
  /** Optimal number of mints */
  optimalMints: number;
  /** Expected DIESEL emission for our mints */
  expectedEmission: number;
  /** Total cost in sats */
  totalCostSats: number;
  /** Net profit in sats */
  netProfitSats: number;
  /** ROI percentage */
  roi: number;
  /** Whether the strategy is profitable */
  isProfitable: boolean;
  /** Reason for decision */
  reason: string;
  /** N* threshold value */
  nStar: number;
  /** Breakeven competition level */
  breakevenM: number;
  /** Whether fee is in preferred range */
  feeInPreferredRange: boolean;
  /** Whether fee is in acceptable range */
  feeInRange: boolean;
  /** Effective competition (M minus our competing chain) */
  effectiveCompetition: number;
}

/**
 * Calculate optimal minting strategy
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
  } = input;

  const feeInPreferredRange = feeRate >= PREFERRED_MIN_FEE && feeRate <= PREFERRED_MAX_FEE;
  const feeInRange = feeRate >= MIN_FEE_RATE && feeRate <= MAX_FEE_RATE;

  // Calculate effective competition
  // Subtract our chain from M only if we're competing for next block
  const weAreCompeting = effectiveRate >= minFeeForNextBlock;
  const chainToSubtract = weAreCompeting ? activeChainLength : 0;
  const M = Math.max(0, competition - chainToSubtract);

  // Pool after protocol fee
  const pool = Math.max(0, blockReward - DIESEL_FEE);

  // TX cost in sats
  const txCost = feeRate * TX_VSIZE;

  // N* = R × p / (2 × f)
  const nStar = (blockReward * dieselPriceSats) / (2 * txCost);
  const breakevenM = nStar / 4;

  // Calculate optimal mints: n* = √(N* × M) - M
  const rawOptimal = M > 0 ? Math.sqrt(nStar * M) - M : 0;

  // Check if single mint is profitable
  const singleMintRevenue = (pool * dieselPriceSats) / (1 + M);
  const singleMintProfitable = singleMintRevenue > txCost;

  // Determine optimal count
  let optimalMints: number;
  if (rawOptimal >= 1) {
    optimalMints = Math.round(rawOptimal);
  } else if (singleMintProfitable) {
    optimalMints = 1;
  } else {
    optimalMints = 0;
  }

  // Cap at chain limit (accounting for existing chain)
  const availableSlots = MAX_CHAIN_LENGTH - activeChainLength;
  optimalMints = Math.min(optimalMints, availableSlots);

  // Calculate expected returns
  const totalMints = optimalMints + M;
  let expectedEmission = 0;
  let costDiesel = 0;
  const txCostDiesel = txCost / dieselPriceSats;

  if (optimalMints > 0 && totalMints > 0) {
    expectedEmission = (optimalMints / totalMints) * pool;
    costDiesel = optimalMints * txCostDiesel;
  }

  const netProfit = expectedEmission - costDiesel;
  const netProfitSats = netProfit * dieselPriceSats;
  const totalCostSats = optimalMints * txCost;
  const roi = totalCostSats > 0 ? (netProfitSats / totalCostSats) * 100 : 0;
  const isProfitable = netProfit > 0;

  // Decision logic
  let shouldMine = false;
  let reason = '';

  if (!feeInRange) {
    reason = feeRate < MIN_FEE_RATE
      ? `Fee ${feeRate.toFixed(3)} < min ${MIN_FEE_RATE} sat/vB`
      : `Fee ${feeRate.toFixed(3)} > max ${MAX_FEE_RATE} sat/vB`;
  } else if (optimalMints <= 0) {
    reason = `Not profitable at M=${M}`;
  } else if (!isProfitable) {
    reason = `Negative ROI: ${roi.toFixed(1)}%`;
  } else if (availableSlots <= 0) {
    reason = `Chain full (${MAX_CHAIN_LENGTH}/${MAX_CHAIN_LENGTH})`;
  } else {
    shouldMine = true;
    reason = feeInPreferredRange
      ? `OPTIMAL: ${optimalMints} mints @ ${feeRate.toFixed(3)} sat/vB (${roi.toFixed(0)}% ROI)`
      : `OK: ${optimalMints} mints @ ${feeRate.toFixed(3)} sat/vB (${roi.toFixed(0)}% ROI)`;
  }

  return {
    shouldMine,
    optimalMints,
    expectedEmission,
    totalCostSats,
    netProfitSats,
    roi,
    isProfitable,
    reason,
    nStar,
    breakevenM,
    feeInPreferredRange,
    feeInRange,
    effectiveCompetition: M,
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
