/**
 * Client-side Algorand testnet wallet for the CLI.
 *
 * Key source precedence: `LUALAMBDA_MNEMONIC` env var wins; otherwise the wallet
 * file at `walletPath()` (default ~/.config/lualambda/wallet.json, mode 0600).
 * Testnet only — never store mainnet keys here.
 *
 * Exposes the ops the CLI `wallet` subcommands need plus the signer key the x402
 * client uses. The signer-key encoding (base64 of the 64-byte sk) is isolated in
 * `signerKeyBase64()` so it's the single place to adjust if the SDK changes.
 */

import { mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import algosdk from 'algosdk';
import { config } from '@/shared/config.ts';

const WALLET_VERSION = 1;

/**
 * The wallet file path, resolved LIVE from `LUALAMBDA_WALLET` each call (default
 * ~/.config/lualambda/wallet.json). Read live — not captured from config — so a
 * caller (or a test) that sets the env var is always honored regardless of
 * module load order. This is the single source of the path; every read/write
 * below goes through it so tests can never touch a real wallet.
 */
export function walletPath(): string {
  return process.env.LUALAMBDA_WALLET || join(homedir(), '.config', 'lualambda', 'wallet.json');
}

interface WalletFile {
  version: number;
  address: string;
  mnemonic: string;
  network: string;
}

export interface Balances {
  algo: bigint;
  /** USDC base units, or null if not opted into the ASA. */
  usdc: bigint | null;
  optedIn: boolean;
}

/** Resolve the 25-word mnemonic from env (preferred) or the wallet file. */
function resolveMnemonic(): string {
  const fromEnv = process.env.LUALAMBDA_MNEMONIC?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(walletPath())) {
    const wf = JSON.parse(readFileSync(walletPath(), 'utf8')) as WalletFile;
    if (wf.mnemonic) return wf.mnemonic;
  }
  throw new Error(
    'no wallet configured — run `lualambda wallet create` (or set LUALAMBDA_MNEMONIC)',
  );
}

export function loadAccount(): algosdk.Account {
  return algosdk.mnemonicToSecretKey(resolveMnemonic());
}

export function address(): string {
  return loadAccount().addr.toString();
}

/** Base64 of the 64-byte secret key (32 seed + 32 pub) — what toClientAvmSigner wants. */
export function signerKeyBase64(): string {
  return Buffer.from(loadAccount().sk).toString('base64');
}

export interface WalletSecrets {
  address: string;
  /** 25-word Algorand mnemonic — what most wallets (Pera, Defly) import. */
  mnemonic: string;
  /** Base64 of the 64-byte secret key (32 seed + 32 pub). */
  secretKeyBase64: string;
  /** Hex of the same 64-byte secret key. */
  secretKeyHex: string;
}

/**
 * Export the active key in every common form so it can be imported elsewhere.
 * Returns SECRET material — callers must treat the result accordingly (the CLI
 * warns before printing). Sources the key via the same precedence as everything
 * else (LUALAMBDA_MNEMONIC wins, else the wallet file).
 */
export function exportSecrets(): WalletSecrets {
  const account = loadAccount();
  return {
    address: account.addr.toString(),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
    secretKeyBase64: Buffer.from(account.sk).toString('base64'),
    secretKeyHex: Buffer.from(account.sk).toString('hex'),
  };
}

function writeWalletFile(account: algosdk.Account): void {
  const file: WalletFile = {
    version: WALLET_VERSION,
    address: account.addr.toString(),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
    network: config.algorandNetwork,
  };
  mkdirSync(dirname(walletPath()), { recursive: true });
  Bun.write(walletPath(), JSON.stringify(file, null, 2));
  chmodSync(walletPath(), 0o600);
}

export function createWallet(force: boolean): { address: string } {
  if (existsSync(walletPath()) && !force) {
    throw new Error(`wallet already exists at ${walletPath()} (use --force to overwrite)`);
  }
  const account = algosdk.generateAccount();
  writeWalletFile(account);
  return { address: account.addr.toString() };
}

export function importWallet(mnemonic: string, force: boolean): { address: string } {
  if (existsSync(walletPath()) && !force) {
    throw new Error(`wallet already exists at ${walletPath()} (use --force to overwrite)`);
  }
  const account = algosdk.mnemonicToSecretKey(mnemonic.trim()); // throws on bad mnemonic
  writeWalletFile(account);
  return { address: account.addr.toString() };
}

function algod(): algosdk.Algodv2 {
  return new algosdk.Algodv2('', config.algodUrl, '');
}

export async function getBalances(): Promise<Balances> {
  const addr = address();
  const info = await algod().accountInformation(addr).do();
  const algo = BigInt(info.amount);
  const asaId = Number(config.usdcAsaId);
  let usdc: bigint | null = null;
  if (asaId > 0) {
    const holding = info.assets?.find((a) => Number(a.assetId) === asaId);
    usdc = holding ? BigInt(holding.amount) : null;
  }
  return { algo, usdc, optedIn: usdc !== null };
}

/** Opt this account into the testnet USDC ASA (0-amount self axfer). Needs ALGO for the fee. */
export async function optIn(): Promise<{ txid: string }> {
  const asaId = Number(config.usdcAsaId);
  if (!asaId) throw new Error(`no USDC ASA for network ${config.network}; cannot opt in`);
  const account = loadAccount();
  const client = algod();
  const suggestedParams = await client.getTransactionParams().do();
  const addr = account.addr.toString();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: addr,
    receiver: addr,
    amount: 0,
    assetIndex: asaId,
    suggestedParams,
  });
  const signed = txn.signTxn(account.sk);
  const { txid } = await client.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(client, txid, 4);
  return { txid };
}
