/**
 * Network Module - Mempool, UTXOs, Broadcasting, Competition Scanning
 */

import {
  MEMPOOL_API,
  MEMPOOL_UTXO_API,
  MEMPOOL_TX_API,
  RPC_URL,
  DIESEL_SCAN_LUA,
  MAX_BROADCAST_RETRIES,
  RETRY_DELAY_MS,
  BROADCAST_DELAY_MS,
} from './config.js';
import pfetch from './pfetch.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface MempoolFees {
  /** Minimum fee rate to get into next block (sat/vB) */
  nextBlockFee: number;
  /** Median fee in the next block */
  medianFee: number;
  /** Number of blocks in mempool queue */
  queueBlocks: number;
  /** Total pending TXs */
  pendingTxs: number;
}

export interface UTXO {
  txid: string;
  vout: number;
  value: number;
  confirmed: boolean;
}

export interface CompetitionScan {
  totalMempool: number;
  qualifying: number;
  dieselMints: number;
}

// ═══════════════════════════════════════════════════════════════
// MEMPOOL FEES
// ═══════════════════════════════════════════════════════════════

export async function fetchMempoolFees(): Promise<MempoolFees> {
  const res = await pfetch(MEMPOOL_API);
  if (!res.ok) throw new Error(`Mempool API error: ${res.status}`);
  
  const blocks: any[] = await res.json();
  
  if (!blocks || blocks.length === 0) {
    return { nextBlockFee: 1, medianFee: 1, queueBlocks: 0, pendingTxs: 0 };
  }

  const nextBlock = blocks[0];
  const nextBlockFee = nextBlock.feeRange?.[0] ?? 1;
  const medianFee = nextBlock.medianFee ?? nextBlockFee;
  const queueBlocks = blocks.length;
  const pendingTxs = blocks.reduce((sum: number, b: any) => sum + (b.nTx || 0), 0);

  return { nextBlockFee, medianFee, queueBlocks, pendingTxs };
}

// ═══════════════════════════════════════════════════════════════
// UTXO MANAGEMENT
// ═══════════════════════════════════════════════════════════════

export async function fetchUtxos(address: string): Promise<UTXO[]> {
  const res = await pfetch(`${MEMPOOL_UTXO_API}/${address}/utxo`);
  if (!res.ok) throw new Error(`UTXO fetch error: ${res.status}`);
  
  const utxos: any[] = await res.json();
  
  return utxos
    .map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: u.status?.confirmed ?? false,
    }))
    .sort((a, b) => b.value - a.value); // Largest first
}

export async function fetchBalance(address: string): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
  const utxos = await fetchUtxos(address);
  const confirmed = utxos.filter(u => u.confirmed).reduce((s, u) => s + u.value, 0);
  const unconfirmed = utxos.filter(u => !u.confirmed).reduce((s, u) => s + u.value, 0);
  return { confirmed, unconfirmed, total: confirmed + unconfirmed };
}

export async function fetchTxHex(txid: string): Promise<string> {
  const res = await pfetch(`${MEMPOOL_TX_API}/${txid}/hex`);
  if (!res.ok) throw new Error(`TX hex fetch error: ${res.status}`);
  return res.text();
}

export async function checkTxStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number }> {
  try {
    const res = await pfetch(`${MEMPOOL_TX_API}/${txid}/status`);
    if (!res.ok) return { confirmed: false };
    const status = await res.json();
    return {
      confirmed: status.confirmed ?? false,
      blockHeight: status.block_height,
    };
  } catch {
    return { confirmed: false };
  }
}

// ═══════════════════════════════════════════════════════════════
// UTXO FETCH VIA RPC (SUBFROST)
// ═══════════════════════════════════════════════════════════════

export async function fetchUtxosViaRpc(address: string): Promise<UTXO[]> {
  const res = await pfetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'esplora_address::utxo',
      params: [address],
    }),
  });

  const data: any = await res.json();
  if (data.error) throw new Error(`RPC UTXO error: ${data.error.message}`);
  
  if (!data.result || !Array.isArray(data.result)) return [];
  
  return data.result
    .map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: u.status?.confirmed ?? false,
    }))
    .sort((a: UTXO, b: UTXO) => b.value - a.value);
}

// ═══════════════════════════════════════════════════════════════
// BROADCASTING
// ═══════════════════════════════════════════════════════════════

export async function broadcastTx(rawTxHex: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_BROADCAST_RETRIES; attempt++) {
    try {
      const res = await pfetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'btc_sendrawtransaction',
          params: [rawTxHex],
        }),
      });

      const data: any = await res.json();
      
      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }

      return data.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Don't retry for certain errors
      if (lastError.message.includes('already in block chain') ||
          lastError.message.includes('txn-already-in-mempool')) {
        throw lastError;
      }

      if (attempt < MAX_BROADCAST_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError || new Error('Broadcast failed after retries');
}

export async function broadcastChain(rawTxHexes: string[]): Promise<string[]> {
  const txids: string[] = [];
  
  for (const hex of rawTxHexes) {
    const txid = await broadcastTx(hex);
    txids.push(txid);
    
    if (rawTxHexes.indexOf(hex) < rawTxHexes.length - 1) {
      await sleep(BROADCAST_DELAY_MS);
    }
  }

  return txids;
}

// ═══════════════════════════════════════════════════════════════
// COMPETITION SCANNING (LUA SCRIPT)
// ═══════════════════════════════════════════════════════════════

export async function scanCompetition(minFeeRate: number): Promise<CompetitionScan> {
  try {
    const res = await pfetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'lua_evalscript',
        params: [DIESEL_SCAN_LUA, minFeeRate.toString()],
      }),
    });

    if (!res.ok) throw new Error(`Scan RPC error: ${res.status}`);
    const data: any = await res.json();
    
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    
    const result = data.result?.returns;
    
    if (result) {
      return {
        totalMempool: result.total_mempool || 0,
        qualifying: result.qualifying || 0,
        dieselMints: result.diesel_mints || 0,
      };
    }

    return { totalMempool: 0, qualifying: 0, dieselMints: 0 };
  } catch (err) {
    // Scan failures are non-fatal - return default
    console.error('  ⚠ Competition scan failed:', (err as Error).message);
    return { totalMempool: 0, qualifying: 0, dieselMints: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// DIESEL PRICE (FROM POOL)
// ═══════════════════════════════════════════════════════════════

export async function fetchDieselPrice(): Promise<number | null> {
  try {
    // DIESEL pool ID: 2:40 (block 2, tx 40) paired with frBTC
    const res = await pfetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'alkanes_pooldetails',
        params: ['2:18'], // DIESEL/frBTC pool
      }),
    });
    
    const data: any = await res.json();
    if (data.result) {
      const r0 = BigInt(data.result.reserve0 || '0');
      const r1 = BigInt(data.result.reserve1 || '0');
      if (r0 > 0n && r1 > 0n) {
        // Price = reserve1 / reserve0 (frBTC sats per DIESEL)
        return Number(r1 * 100000000n / r0) / 100000000;
      }
    }
  } catch {
    // Non-fatal
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// BLOCK HEIGHT
// ═══════════════════════════════════════════════════════════════

export async function fetchBlockHeight(): Promise<number> {
  try {
    const res = await pfetch('https://mempool.space/api/blocks/tip/height');
    if (res.ok) return parseInt(await res.text());
  } catch {}
  
  // Fallback to RPC
  const res = await pfetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'btc_getblockcount',
      params: [],
    }),
  });
  const data: any = await res.json();
  return data.result || 0;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
