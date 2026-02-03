#!/usr/bin/env tsx
/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              DIESEL AUTONOMOUS MINER v1.0                    ║
 * ║                                                              ║
 * ║  Mines DIESEL tokens on Bitcoin L1 via Alkanes protocol.     ║
 * ║  Runs autonomously until wallet balance is depleted.         ║
 * ║                                                              ║
 * ║  Strategy: Mint in 0.17-0.2 sat/vB range (profitable ≤1.5)  ║
 * ║  Formula:  n* = √(N*·M) - M  where N* = Rp/2f              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 */

import 'dotenv/config';

import { createWallet, generateWallet, type WalletInfo } from './wallet.js';
import {
  fetchMempoolFees,
  fetchUtxos,
  fetchBalance,
  scanCompetition,
  fetchBlockHeight,
  fetchDieselPrice,
  checkTxStatus,
  type UTXO,
  type MempoolFees,
  type CompetitionScan,
} from './network.js';
import { calculateStrategy, shouldAutoRbf, type StrategyResult } from './strategy.js';
import {
  executeChainMint,
  rbfLastTx,
  getEffectiveRate,
  type ChainState,
} from './minter.js';
import {
  BLOCK_CHECK_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  MIN_BALANCE_SATS,
  DEFAULT_BLOCK_REWARD,
  DEFAULT_DIESEL_PRICE_SATS,
  MAX_CHAIN_LENGTH,
  RBF_BUFFER_FACTOR,
  POST_CONFIRM_DELAY_MS,
  TX_VSIZE,
  MINING_WINDOW_START_MS,
} from './config.js';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

interface MinerState {
  wallet: WalletInfo;
  chain: ChainState | null;
  lastBlockHeight: number;
  lastBlockTime: number;          // When last block was detected
  totalMined: number;
  totalFeesPaid: number;
  cyclesCompleted: number;
  startTime: number;
  dieselPrice: number;
  blockReward: number;
  isMinting: boolean;
  isRbfing: boolean;
  lastError: string | null;
  consecutiveErrors: number;
}

// ═══════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function log(msg: string, color = COLORS.white) {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  console.log(`${COLORS.gray}[${ts}]${COLORS.reset} ${color}${msg}${COLORS.reset}`);
}

function logHeader(msg: string) {
  console.log(`\n${COLORS.cyan}${'═'.repeat(60)}${COLORS.reset}`);
  console.log(`${COLORS.bright}${COLORS.cyan}  ${msg}${COLORS.reset}`);
  console.log(`${COLORS.cyan}${'═'.repeat(60)}${COLORS.reset}`);
}

function logStatus(
  fees: MempoolFees, 
  scan: CompetitionScan, 
  balance: number, 
  state: MinerState,
  secondsSinceBlock: number,
  inMiningWindow: boolean
) {
  const eff = state.chain ? getEffectiveRate(state.chain).toFixed(3) : '---';
  const chainLen = state.chain?.chainLength ?? 0;
  const mins = Math.floor(secondsSinceBlock / 60);
  const secs = Math.floor(secondsSinceBlock % 60);
  const windowStatus = inMiningWindow ? '✓' : `wait ${Math.ceil((MINING_WINDOW_START_MS/1000 - secondsSinceBlock)/60)}m`;

  console.log(
    `${COLORS.gray}  FEE ${COLORS.yellow}${fees.nextBlockFee.toFixed(3)}${COLORS.gray} | ` +
    `M ${COLORS.magenta}${scan.dieselMints}${COLORS.gray} | ` +
    `BLK ${COLORS.cyan}${mins}m${secs}s${COLORS.gray} [${windowStatus}] | ` +
    `CHAIN ${COLORS.cyan}${chainLen}/${MAX_CHAIN_LENGTH}${COLORS.gray} @ ${COLORS.cyan}${eff}${COLORS.gray} | ` +
    `BAL ${COLORS.green}${(balance / 1e8).toFixed(8)}${COLORS.reset}`
  );
}

// ═══════════════════════════════════════════════════════════════
// CORE MINING LOOP (BLOCK-AWARE)
// ═══════════════════════════════════════════════════════════════

async function runMiningLoop(state: MinerState): Promise<void> {
  log('Mining loop active — block-aware monitoring...', COLORS.green);
  log(`  Block check: every ${BLOCK_CHECK_INTERVAL_MS/1000}s | Full assessment: on new block or every ${IDLE_POLL_INTERVAL_MS/60000}min`, COLORS.gray);
  
  let lastFundingNotice = 0;
  let lastFullAssessment = 0;

  while (true) {
    try {
      // ─── Quick block height check (cheap) ───────────────
      const blockHeight = await fetchBlockHeight();
      const newBlockDetected = blockHeight > state.lastBlockHeight && state.lastBlockHeight > 0;
      const timeSinceAssessment = Date.now() - lastFullAssessment;
      const hasActiveChain = state.chain !== null;
      
      // Decide whether to do full assessment
      const shouldAssess = newBlockDetected || 
                           timeSinceAssessment > IDLE_POLL_INTERVAL_MS ||
                           hasActiveChain ||
                           lastFullAssessment === 0;
      
      if (!shouldAssess) {
        // Just a quick block check - sleep and continue
        await sleep(BLOCK_CHECK_INTERVAL_MS);
        continue;
      }

      // ─── Full assessment ────────────────────────────────
      if (newBlockDetected) {
        log(`🧱 New block: ${blockHeight} — resetting timer`, COLORS.green);
        state.lastBlockHeight = blockHeight;
        state.lastBlockTime = Date.now();
      } else if (state.lastBlockHeight === 0) {
        state.lastBlockHeight = blockHeight;
        state.lastBlockTime = Date.now();
      }

      const [fees, balance] = await Promise.all([
        fetchMempoolFees(),
        fetchBalance(state.wallet.address),
      ]);

      const scan = await scanCompetition(fees.nextBlockFee);
      const now = Date.now();
      lastFullAssessment = now;

      // How long since last block?
      const msSinceBlock = now - state.lastBlockTime;
      const secondsSinceBlock = msSinceBlock / 1000;
      
      // Are we in the mining window? (waited long enough for M to settle)
      const inMiningWindow = msSinceBlock >= MINING_WINDOW_START_MS || state.chain !== null;

      // Update diesel price periodically
      if (state.cyclesCompleted % 10 === 0) {
        const price = await fetchDieselPrice();
        if (price && price > 0) {
          state.dieselPrice = price;
        }
      }

      // Log status
      logStatus(fees, scan, balance.total, state, secondsSinceBlock, inMiningWindow);

      // Evaluate strategy
      const activeChainLen = state.chain?.chainLength ?? 0;
      const activeRate = state.chain ? getEffectiveRate(state.chain) : 0;
      const strategy = calculateStrategy({
        feeRate: fees.nextBlockFee,
        competition: scan.dieselMints,
        blockReward: state.blockReward,
        dieselPriceSats: state.dieselPrice,
        activeChainLength: activeChainLen,
        effectiveRate: activeRate,
        minFeeForNextBlock: fees.nextBlockFee,
        inMiningWindow,
      });

      // ─── UNFUNDED: show strategy evaluation, wait ──────
      if (balance.total < MIN_BALANCE_SATS && !state.chain) {
        const now = Date.now();
        if (strategy.shouldMine) {
          log(`  📊 Conditions FAVORABLE: ${strategy.reason}`, COLORS.green);
          log(
            `${COLORS.gray}     n*=${COLORS.cyan}${strategy.optimalMints}${COLORS.gray} | ` +
            `M=${COLORS.magenta}${strategy.currentM}${COLORS.gray} | ` +
            `ROI=${strategy.roi >= 0 ? COLORS.green : COLORS.red}${strategy.roi.toFixed(1)}%${COLORS.gray} | ` +
            `EXP=${COLORS.cyan}${strategy.expectedEmission.toFixed(2)}${COLORS.gray} DSL${COLORS.reset}`, ''
          );
        } else {
          log(`  📊 Conditions: ${strategy.reason}`, COLORS.gray);
        }
        if (now - lastFundingNotice > 120_000) {
          log(`  💰 Awaiting deposit to: ${state.wallet.address}`, COLORS.yellow);
          lastFundingNotice = now;
        }
        state.consecutiveErrors = 0;
        state.lastError = null;
        await sleep(BLOCK_CHECK_INTERVAL_MS);
        continue;
      }

      // ─── 2. Check active chain status ──────────────────
      if (state.chain) {
        const firstTxStatus = await checkTxStatus(state.chain.txids[0]);
        
        if (firstTxStatus.confirmed) {
          log(`✅ Chain CONFIRMED (${state.chain.chainLength} TXs, ${state.chain.totalFees} sats fees)`, COLORS.green);
          state.cyclesCompleted++;
          state.totalFeesPaid += state.chain.totalFees;
          state.chain = null;
          await sleep(POST_CONFIRM_DELAY_MS);
          continue;
        }

        // ─── 3. Auto-RBF if needed ────────────────────────
        const effectiveRate = getEffectiveRate(state.chain);
        const rbfCheck = shouldAutoRbf(
          effectiveRate,
          fees.nextBlockFee,
          true,
          RBF_BUFFER_FACTOR,
        );

        if (rbfCheck.shouldRbf && !state.isRbfing && !state.isMinting) {
          log(`⚡ Auto-RBF: ${rbfCheck.reason}`, COLORS.yellow);
          state.isRbfing = true;
          
          try {
            state.chain = await rbfLastTx(state.wallet, state.chain, rbfCheck.targetRate);
            const newRate = getEffectiveRate(state.chain);
            log(`  ✓ RBF OK: effective rate now ${newRate.toFixed(3)} sat/vB`, COLORS.green);
          } catch (err) {
            log(`  ✗ RBF failed: ${(err as Error).message}`, COLORS.red);
          } finally {
            state.isRbfing = false;
          }
        }

        // ─── 4. Extend chain if possible ──────────────────
        if (state.chain.chainLength < MAX_CHAIN_LENGTH && !state.isMinting && !state.isRbfing) {
          if (strategy.shouldMine && strategy.optimalMints > 0) {
            const toMint = Math.min(
              strategy.optimalMints,
              MAX_CHAIN_LENGTH - state.chain.chainLength
            );

            if (toMint > 0) {
              log(`➕ Extending chain: +${toMint} TXs (${strategy.reason})`, COLORS.cyan);
              state.isMinting = true;

              try {
                const dummyUtxo: UTXO = {
                  txid: state.chain.lastOutput.txid,
                  vout: state.chain.lastOutput.vout,
                  value: state.chain.lastOutput.value,
                  confirmed: false,
                };

                state.chain = await executeChainMint(
                  state.wallet,
                  dummyUtxo,
                  toMint,
                  fees.nextBlockFee,
                  state.chain,
                );

                state.totalMined += toMint;
                log(`  ✓ Chain extended to ${state.chain.chainLength}/${MAX_CHAIN_LENGTH}`, COLORS.green);
              } catch (err) {
                log(`  ✗ Chain extension failed: ${(err as Error).message}`, COLORS.red);
              } finally {
                state.isMinting = false;
              }
            }
          }
        }

      } else {
        // ─── 5. No active chain - evaluate new mint ───────
        // POST-BLOCK is optimal time: M is lowest right after a block clears
        if (newBlockDetected && strategy.shouldMine) {
          log(`  ⚡ Post-block window — optimal time to mine!`, COLORS.bright + COLORS.cyan);
        }

        if (strategy.shouldMine && strategy.optimalMints > 0 && !state.isMinting) {
          logNewMintDecision(strategy, fees, scan);

          const utxos = await fetchUtxos(state.wallet.address);
          const confirmedUtxos = utxos.filter(u => u.confirmed);
          
          if (confirmedUtxos.length === 0) {
            log('  ⏳ No confirmed UTXOs available, waiting...', COLORS.yellow);
          } else {
            const bestUtxo = confirmedUtxos[0];
            const minNeeded = strategy.optimalMints * Math.ceil(TX_VSIZE * fees.nextBlockFee + 330);
            
            if (bestUtxo.value < minNeeded) {
              log(`  ⚠ Best UTXO (${bestUtxo.value} sats) too small for ${strategy.optimalMints} mints`, COLORS.yellow);
            } else {
              state.isMinting = true;
              
              try {
                state.chain = await executeChainMint(
                  state.wallet,
                  bestUtxo,
                  strategy.optimalMints,
                  fees.nextBlockFee,
                );

                state.totalMined += strategy.optimalMints;
                log(
                  `  ✓ Chain created: ${state.chain.chainLength} TXs, ` +
                  `${state.chain.totalFees} sats fees, ` +
                  `effective rate: ${getEffectiveRate(state.chain).toFixed(3)} sat/vB`,
                  COLORS.green
                );
              } catch (err) {
                log(`  ✗ Mint failed: ${(err as Error).message}`, COLORS.red);
                state.chain = null;
              } finally {
                state.isMinting = false;
              }
            }
          }
        } else if (!strategy.shouldMine) {
          log(`  💤 ${strategy.reason}`, COLORS.gray);
        }
      }

      // Reset consecutive errors on success
      state.consecutiveErrors = 0;
      state.lastError = null;

    } catch (err) {
      state.consecutiveErrors++;
      state.lastError = (err as Error).message;
      log(`❌ Error: ${state.lastError}`, COLORS.red);

      if (state.consecutiveErrors >= 10) {
        log('Too many consecutive errors. Pausing for 60s...', COLORS.red);
        await sleep(60_000);
        state.consecutiveErrors = 0;
      }
    }

    // Wait before next block check
    await sleep(BLOCK_CHECK_INTERVAL_MS);
  }
}

function logNewMintDecision(strategy: StrategyResult, fees: MempoolFees, scan: CompetitionScan) {
  log(`🔥 MINING: ${strategy.reason}`, COLORS.bright + COLORS.green);
  console.log(
    `${COLORS.gray}  ` +
    `n*=${COLORS.cyan}${strategy.optimalMints}${COLORS.gray} | ` +
    `M=${COLORS.magenta}${strategy.currentM}${COLORS.gray} | ` +
    `ROI=${strategy.roi >= 0 ? COLORS.green : COLORS.red}${strategy.roi.toFixed(1)}%${COLORS.gray} | ` +
    `EXP=${COLORS.cyan}${strategy.expectedEmission.toFixed(2)}${COLORS.gray} DSL | ` +
    `COST=${COLORS.yellow}${Math.round(strategy.totalCostSats)}${COLORS.gray} sats | ` +
    `NET=${strategy.netProfitSats >= 0 ? COLORS.green : COLORS.red}${Math.round(strategy.netProfitSats)}${COLORS.gray} sats${COLORS.reset}`
  );
}

function printSummary(state: MinerState) {
  const elapsed = (Date.now() - state.startTime) / 1000 / 60;
  logHeader('MINING SESSION SUMMARY');
  console.log(`  Address:          ${state.wallet.address}`);
  console.log(`  Runtime:          ${elapsed.toFixed(1)} minutes`);
  console.log(`  Total TXs mined:  ${state.totalMined}`);
  console.log(`  Cycles completed: ${state.cyclesCompleted}`);
  console.log(`  Total fees paid:  ${state.totalFeesPaid} sats (${(state.totalFeesPaid / 1e8).toFixed(8)} BTC)`);
  console.log('');
}

// ═══════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`
${COLORS.cyan}╔═══════════════════════════════════════════════════════════════╗
║              ${COLORS.bright}DIESEL AUTONOMOUS MINER v1.0${COLORS.reset}${COLORS.cyan}                    ║
║                                                               ║
║  Strategy: mint @ 0.17-0.20 sat/vB (profitable up to ~1.5)   ║
║  Formula:  n* = √(N*·M) - M  where N* = Rp/2f               ║
║  Features: auto-chain, auto-RBF, competition scanning         ║
╚═══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

  // Get mnemonic from environment or argument
  const mnemonic = process.env.MNEMONIC || process.argv[2];

  if (!mnemonic) {
    console.log(`${COLORS.yellow}Usage:${COLORS.reset}`);
    console.log(`  MNEMONIC="word1 word2 ... word12" npx tsx index.ts`);
    console.log(`  npx tsx index.ts "word1 word2 ... word12"`);
    console.log('');
    console.log(`${COLORS.gray}Or generate a new wallet:${COLORS.reset}`);
    console.log('  npx tsx wallet-gen.ts');
    console.log('');
    process.exit(1);
  }

  // Create wallet
  let wallet: WalletInfo;
  try {
    wallet = createWallet(mnemonic);
  } catch (err) {
    log(`Failed to create wallet: ${(err as Error).message}`, COLORS.red);
    process.exit(1);
  }

  logHeader('WALLET');
  console.log(`  Address: ${COLORS.bright}${wallet.address}${COLORS.reset}`);
  console.log(`  Type:    P2TR (BIP86)`);
  console.log(`  Path:    m/86'/0'/0'/0/0`);

  // Fetch initial balance
  try {
    const balance = await fetchBalance(wallet.address);
    console.log(`  Balance: ${COLORS.green}${(balance.total / 1e8).toFixed(8)} BTC${COLORS.reset} (${balance.total} sats)`);
    console.log(`           Confirmed: ${balance.confirmed} | Unconfirmed: ${balance.unconfirmed}`);
    if (balance.total < MIN_BALANCE_SATS) {
      log(`Awaiting funding (need ≥${MIN_BALANCE_SATS} sats to begin mining)`, COLORS.yellow);
      log(`Deposit BTC to: ${wallet.address}`, COLORS.yellow);
      log(`Monitoring conditions in the meantime...`, COLORS.gray);
    }
  } catch (err) {
    log(`Failed to fetch initial balance: ${(err as Error).message} — continuing anyway`, COLORS.yellow);
  }

  // Fetch block height
  const blockHeight = await fetchBlockHeight();
  console.log(`  Block:   ${blockHeight}`);

  // Check for existing unconfirmed TXs (detect in-progress chains)
  const utxos = await fetchUtxos(wallet.address);
  const unconfirmedUtxos = utxos.filter(u => !u.confirmed);
  if (unconfirmedUtxos.length > 0) {
    log(`Found ${unconfirmedUtxos.length} unconfirmed UTXOs - may have existing chain`, COLORS.yellow);
  }

  // Initialize state
  const state: MinerState = {
    wallet,
    chain: null,
    lastBlockHeight: blockHeight,
    lastBlockTime: Date.now(),
    totalMined: 0,
    totalFeesPaid: 0,
    cyclesCompleted: 0,
    startTime: Date.now(),
    dieselPrice: DEFAULT_DIESEL_PRICE_SATS,
    blockReward: DEFAULT_BLOCK_REWARD,
    isMinting: false,
    isRbfing: false,
    lastError: null,
    consecutiveErrors: 0,
  };

  // Fetch initial diesel price
  const price = await fetchDieselPrice();
  if (price && price > 0) {
    state.dieselPrice = price;
    log(`DIESEL price: ${price.toFixed(2)} sats`, COLORS.cyan);
  } else {
    log(`Using default DIESEL price: ${DEFAULT_DIESEL_PRICE_SATS} sats`, COLORS.yellow);
  }

  logHeader('MINING STARTED');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('');
    log('Received SIGINT, shutting down...', COLORS.yellow);
    printSummary(state);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, shutting down...', COLORS.yellow);
    printSummary(state);
    process.exit(0);
  });

  // Start mining
  await runMiningLoop(state);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
