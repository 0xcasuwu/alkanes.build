#!/usr/bin/env tsx
/**
 * Wallet Generator - Create a new BIP86 P2TR wallet for DIESEL mining
 */

import { generateWallet } from './wallet.js';

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

console.log(`
${COLORS.cyan}╔═══════════════════════════════════════════════════════════════╗
║              DIESEL Wallet Generator                          ║
╚═══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

const { wallet, mnemonic } = generateWallet();

console.log(`${COLORS.bright}Mnemonic (SAVE THIS - CANNOT BE RECOVERED):${COLORS.reset}`);
console.log(`${COLORS.yellow}  ${mnemonic}${COLORS.reset}`);
console.log('');
console.log(`${COLORS.bright}Address:${COLORS.reset}`);
console.log(`${COLORS.green}  ${wallet.address}${COLORS.reset}`);
console.log('');
console.log(`${COLORS.gray}Derivation path: m/86'/0'/0'/0/0 (BIP86 P2TR)${COLORS.reset}`);
console.log('');
console.log(`${COLORS.bright}To start mining:${COLORS.reset}`);
console.log(`  1. Send BTC to ${wallet.address}`);
console.log(`  2. Run: MNEMONIC="${mnemonic}" npx tsx index.ts`);
console.log('');
console.log(`${COLORS.red}⚠  WRITE DOWN YOUR MNEMONIC. IT IS THE ONLY WAY TO RECOVER YOUR WALLET.${COLORS.reset}`);
