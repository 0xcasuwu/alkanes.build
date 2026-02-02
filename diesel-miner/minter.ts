/**
 * Minter Module - DIESEL Mint Transaction Construction, Chaining, and RBF
 * 
 * Builds P2TR DIESEL mint transactions with OP_RETURN,
 * creates chains of up to 25 unconfirmed TXs,
 * and handles RBF fee bumps.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { WalletInfo, signAndFinalize } from './wallet.js';
import { broadcastTx, fetchTxHex, type UTXO } from './network.js';
import {
  TX_VSIZE,
  DUST_LIMIT,
  RBF_SEQUENCE,
  DIESEL_MINT_OP_RETURN,
  INCREMENTAL_RELAY_FEE,
  BROADCAST_DELAY_MS,
} from './config.js';

bitcoin.initEccLib(ecc);

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface ChainState {
  /** All txids in the chain */
  txids: string[];
  /** Raw TX hex of last TX in chain (for RBF) */
  lastRawTxHex: string;
  /** Input UTXO of the last TX (for RBF replacement) */
  lastTxInput: {
    txid: string;
    vout: number;
    value: number;
    rawTxHex: string;
  };
  /** Output of last TX (for extending chain / CPFP) */
  lastOutput: {
    txid: string;
    vout: number;
    value: number;
    rawTxHex: string;
  };
  /** Fee of last TX only */
  lastTxFee: number;
  /** Total fees for entire chain */
  totalFees: number;
  /** Total vsize for entire chain */
  totalVsize: number;
  /** Fees for all TXs except the last one */
  feesExcludingLast: number;
  /** Number of TXs in chain */
  chainLength: number;
  /** Source UTXO that started this chain */
  sourceUtxo: { txid: string; vout: number };
}

export interface MintResult {
  txid: string;
  outputValue: number;
  rawTxHex: string;
  fee: number;
  inputUtxo: { txid: string; vout: number; value: number; rawTxHex: string };
}

// ═══════════════════════════════════════════════════════════════
// OP_RETURN SCRIPT
// ═══════════════════════════════════════════════════════════════

function getDieselMintOpReturn(): Buffer {
  return Buffer.from(DIESEL_MINT_OP_RETURN, 'hex');
}

// ═══════════════════════════════════════════════════════════════
// SINGLE MINT TRANSACTION
// ═══════════════════════════════════════════════════════════════

/**
 * Build, sign, and broadcast a single DIESEL mint transaction
 */
export async function executeMint(
  wallet: WalletInfo,
  utxo: { txid: string; vout: number; value: number; rawTxHex?: string },
  feeRate: number,
  exactFee?: number,
): Promise<MintResult> {
  const network = wallet.network;
  const opReturnScript = getDieselMintOpReturn();

  // Calculate fee
  const fee = exactFee !== undefined ? exactFee : Math.ceil(TX_VSIZE * feeRate);
  const outputValue = utxo.value - fee;

  if (outputValue < DUST_LIMIT) {
    throw new Error(
      `Insufficient funds: ${utxo.value} sats, need ${fee + DUST_LIMIT} (fee: ${fee})`
    );
  }

  // Fetch raw TX hex if not provided
  let rawTxHex = utxo.rawTxHex;
  if (!rawTxHex) {
    rawTxHex = await fetchTxHex(utxo.txid);
  }

  // Build PSBT
  const psbt = new bitcoin.Psbt({ network });
  const outputScript = bitcoin.address.toOutputScript(wallet.address, network);

  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    sequence: RBF_SEQUENCE,
    witnessUtxo: {
      script: outputScript,
      value: BigInt(utxo.value),
    },
    tapInternalKey: wallet.internalKey,
  });

  // Output 0: Change back to self (receives minted DIESEL)
  psbt.addOutput({
    address: wallet.address,
    value: BigInt(outputValue),
  });

  // Output 1: OP_RETURN with DIESEL mint payload
  psbt.addOutput({
    script: opReturnScript,
    value: BigInt(0),
  });

  // Sign and finalize
  const { txHex, txid } = signAndFinalize(wallet, psbt);

  // Broadcast
  await broadcastTx(txHex);

  return {
    txid,
    outputValue,
    rawTxHex: txHex,
    fee,
    inputUtxo: {
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      rawTxHex: rawTxHex,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// CHAIN MINTING
// ═══════════════════════════════════════════════════════════════

/**
 * Execute a chain of DIESEL mint transactions
 */
export async function executeChainMint(
  wallet: WalletInfo,
  initialUtxo: UTXO,
  mintCount: number,
  feeRate: number,
  existingChain?: ChainState,
): Promise<ChainState> {
  const txids: string[] = existingChain ? [...existingChain.txids] : [];
  let totalFees = existingChain?.totalFees ?? 0;
  let feesExcludingLast = existingChain ? existingChain.totalFees : 0; // everything before new batch
  let chainLength = existingChain?.chainLength ?? 0;

  // Determine starting UTXO
  let currentUtxo: { txid: string; vout: number; value: number; rawTxHex?: string };
  
  if (existingChain) {
    // Continue from last output of existing chain
    currentUtxo = {
      txid: existingChain.lastOutput.txid,
      vout: existingChain.lastOutput.vout,
      value: existingChain.lastOutput.value,
      rawTxHex: existingChain.lastOutput.rawTxHex,
    };
  } else {
    currentUtxo = {
      txid: initialUtxo.txid,
      vout: initialUtxo.vout,
      value: initialUtxo.value,
    };
  }

  let lastMintResult: MintResult | null = null;
  let firstTxInputUtxo: { txid: string; vout: number; value: number; rawTxHex: string } | null = null;

  for (let i = 0; i < mintCount; i++) {
    const result = await executeMint(wallet, currentUtxo, feeRate);

    txids.push(result.txid);
    totalFees += result.fee;
    chainLength++;

    // Track fees excluding last TX
    if (i < mintCount - 1) {
      feesExcludingLast += result.fee;
    }

    // Track first TX input for RBF of this batch's first TX
    if (i === 0) {
      firstTxInputUtxo = result.inputUtxo;
    }

    lastMintResult = result;

    // Set up next UTXO in chain
    if (i < mintCount - 1) {
      currentUtxo = {
        txid: result.txid,
        vout: 0,
        value: result.outputValue,
        rawTxHex: result.rawTxHex,
      };

      // Small delay between broadcasts
      await sleep(BROADCAST_DELAY_MS);
    }
  }

  if (!lastMintResult) {
    throw new Error('No transactions were created');
  }

  const sourceUtxo = existingChain?.sourceUtxo ?? {
    txid: initialUtxo.txid,
    vout: initialUtxo.vout,
  };

  return {
    txids,
    lastRawTxHex: lastMintResult.rawTxHex,
    lastTxInput: lastMintResult.inputUtxo,
    lastOutput: {
      txid: lastMintResult.txid,
      vout: 0,
      value: lastMintResult.outputValue,
      rawTxHex: lastMintResult.rawTxHex,
    },
    lastTxFee: lastMintResult.fee,
    totalFees,
    totalVsize: chainLength * TX_VSIZE,
    feesExcludingLast,
    chainLength,
    sourceUtxo,
  };
}

// ═══════════════════════════════════════════════════════════════
// RBF (REPLACE-BY-FEE)
// ═══════════════════════════════════════════════════════════════

/**
 * Replace the last transaction in a chain with a higher fee version.
 * 
 * To achieve a target effective rate for the WHOLE chain:
 *   targetRate = totalFees / totalVsize
 *   newLastTxFee = targetRate * totalVsize - feesExcludingLast
 */
export async function rbfLastTx(
  wallet: WalletInfo,
  chain: ChainState,
  targetEffectiveRate: number,
): Promise<ChainState> {
  // Calculate required fee for the last TX
  const requiredLastTxFee = Math.ceil(
    targetEffectiveRate * chain.totalVsize - chain.feesExcludingLast
  );

  // Minimum RBF fee: old_fee + incremental_relay_fee * vsize
  const minRbfFee = chain.lastTxFee + Math.ceil(TX_VSIZE * INCREMENTAL_RELAY_FEE);
  const actualLastTxFee = Math.max(requiredLastTxFee, minRbfFee);

  if (actualLastTxFee <= chain.lastTxFee) {
    throw new Error(
      `Cannot RBF: target fee ${actualLastTxFee} <= current ${chain.lastTxFee}`
    );
  }

  // Re-execute the last TX with the same input but higher fee
  const result = await executeMint(
    wallet,
    chain.lastTxInput,
    0, // feeRate ignored with exactFee
    actualLastTxFee,
  );

  // Update chain state
  const newTxids = [...chain.txids];
  newTxids[newTxids.length - 1] = result.txid; // Replace last txid

  const newTotalFees = chain.feesExcludingLast + actualLastTxFee;

  return {
    ...chain,
    txids: newTxids,
    lastRawTxHex: result.rawTxHex,
    lastOutput: {
      txid: result.txid,
      vout: 0,
      value: result.outputValue,
      rawTxHex: result.rawTxHex,
    },
    lastTxFee: actualLastTxFee,
    totalFees: newTotalFees,
  };
}

/**
 * Calculate current effective fee rate for a chain
 */
export function getEffectiveRate(chain: ChainState): number {
  return chain.totalVsize > 0 ? chain.totalFees / chain.totalVsize : 0;
}

/**
 * Calculate minimum achievable effective rate via RBF
 */
export function getMinRbfRate(chain: ChainState): number {
  const minLastTxFee = chain.lastTxFee + Math.ceil(TX_VSIZE * INCREMENTAL_RELAY_FEE);
  return chain.totalVsize > 0
    ? (chain.feesExcludingLast + minLastTxFee) / chain.totalVsize
    : 0;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
