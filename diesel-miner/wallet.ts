/**
 * Wallet Module - BIP86 P2TR Key Management & PSBT Signing
 * 
 * Derives taproot keys from a BIP39 mnemonic and signs PSBTs.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import BIP32Factory from 'bip32';
import * as bip39 from 'bip39';
import { DERIVATION_PATH } from './config.js';

// Initialize ECC library
bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

export interface WalletInfo {
  address: string;
  publicKey: Buffer;
  internalKey: Buffer; // x-only (32 bytes)
  privateKey: Buffer;
  network: bitcoin.Network;
}

/**
 * Tweak a private key for taproot key-path spend
 * Uses ecc library's native modular arithmetic (no BigInt conversion needed)
 */
function tweakPrivateKey(privKey: Buffer, pubKey: Buffer): Buffer {
  const xOnlyPubKey = pubKey.length === 33 ? pubKey.subarray(1) : pubKey;
  const tweakHash = bitcoin.crypto.taggedHash('TapTweak', Buffer.from(xOnlyPubKey));
  
  let key = new Uint8Array(privKey);
  
  // If pubkey Y coordinate is odd, negate the private key first
  if (pubKey.length === 33 && pubKey[0] === 0x03) {
    key = new Uint8Array(ecc.privateNegate(key));
  }
  
  // Add tweak to (possibly negated) private key (mod secp256k1 order)
  const tweaked = ecc.privateAdd(key, new Uint8Array(tweakHash));
  if (!tweaked) throw new Error('Invalid tweaked key (point at infinity)');
  
  return Buffer.from(tweaked);
}

/**
 * Convert witness stack to script witness (serialized format)
 */
function witnessStackToScriptWitness(witness: Buffer[]): Buffer {
  let buffer = Buffer.allocUnsafe(0);

  function writeSlice(slice: Buffer): void {
    buffer = Buffer.concat([buffer, slice]);
  }

  function writeVarInt(i: number): void {
    if (i < 0xfd) {
      const buf = Buffer.allocUnsafe(1);
      buf.writeUInt8(i, 0);
      writeSlice(buf);
    } else if (i <= 0xffff) {
      const buf = Buffer.allocUnsafe(3);
      buf.writeUInt8(0xfd, 0);
      buf.writeUInt16LE(i, 1);
      writeSlice(buf);
    } else {
      const buf = Buffer.allocUnsafe(5);
      buf.writeUInt8(0xfe, 0);
      buf.writeUInt32LE(i, 1);
      writeSlice(buf);
    }
  }

  function writeVector(vector: Buffer[]): void {
    writeVarInt(vector.length);
    vector.forEach((item) => {
      writeVarInt(item.length);
      writeSlice(item);
    });
  }

  writeVector(witness);
  return buffer;
}

/**
 * Create a wallet from a BIP39 mnemonic
 */
export function createWallet(mnemonic: string): WalletInfo {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, bitcoin.networks.bitcoin);
  const child = root.derivePath(DERIVATION_PATH);

  if (!child.privateKey) {
    throw new Error('Failed to derive private key');
  }

  const publicKey = Buffer.from(child.publicKey);
  const privateKey = Buffer.from(child.privateKey);
  const internalKey = publicKey.length === 33 ? publicKey.subarray(1) : publicKey;

  // Compute taproot address
  const { address } = bitcoin.payments.p2tr({
    internalPubkey: internalKey,
    network: bitcoin.networks.bitcoin,
  });

  if (!address) {
    throw new Error('Failed to derive taproot address');
  }

  return {
    address,
    publicKey,
    internalKey,
    privateKey,
    network: bitcoin.networks.bitcoin,
  };
}

/**
 * Generate a new random wallet
 */
export function generateWallet(): { wallet: WalletInfo; mnemonic: string } {
  const mnemonic = bip39.generateMnemonic(128); // 12 words
  const wallet = createWallet(mnemonic);
  return { wallet, mnemonic };
}

/**
 * Compute the tweaked output public key for a taproot internal key
 */
function getTweakedOutputKey(internalKey: Buffer): Buffer {
  const tweakHash = bitcoin.crypto.taggedHash('TapTweak', Buffer.from(internalKey));
  const result = ecc.xOnlyPointAddTweak(new Uint8Array(internalKey), new Uint8Array(tweakHash));
  if (!result || result.xOnlyPubkey === null) throw new Error('Failed to tweak public key');
  return Buffer.from(result.xOnlyPubkey);
}

/**
 * Sign a PSBT with the wallet's taproot key (key-path spend)
 * bitcoinjs-lib v7 requires a Schnorr signer for taproot inputs
 */
export function signPsbt(wallet: WalletInfo, psbt: bitcoin.Psbt): bitcoin.Psbt {
  const tweakedKey = tweakPrivateKey(wallet.privateKey, wallet.publicKey);
  const tweakedPubKey = getTweakedOutputKey(wallet.internalKey);

  // Taproot signer: publicKey must be the tweaked output key
  // Cast as 'any' because bitcoinjs-lib's overloaded signInput accepts
  // either Signer (ECDSA) or SignerSchnorr (taproot) but TS union is strict
  const schnorrSigner: any = {
    publicKey: tweakedPubKey, // x-only tweaked output pubkey (32 bytes)
    signSchnorr: (hash: Buffer): Buffer => {
      return Buffer.from(ecc.signSchnorr(hash, tweakedKey));
    },
  };

  for (let i = 0; i < psbt.inputCount; i++) {
    psbt.signInput(i, schnorrSigner);
  }

  return psbt;
}

/**
 * Sign and finalize a PSBT, returning the raw transaction hex
 */
export function signAndFinalize(wallet: WalletInfo, psbt: bitcoin.Psbt): { txHex: string; txid: string } {
  // Sign
  signPsbt(wallet, psbt);

  // Finalize each input
  for (let i = 0; i < psbt.inputCount; i++) {
    const input = psbt.data.inputs[i];
    if (input.tapKeySig) {
      psbt.finalizeInput(i, () => ({
        finalScriptWitness: witnessStackToScriptWitness([Buffer.from(input.tapKeySig!)]),
      }));
    } else {
      psbt.finalizeInput(i);
    }
  }

  const tx = psbt.extractTransaction();
  return {
    txHex: tx.toHex(),
    txid: tx.getId(),
  };
}
