import { test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import algosdk from 'algosdk';

// config.walletPath is captured at import time from LUALAMBDA_WALLET, so set it
// BEFORE importing the wallet module (done via a fresh dynamic import per case).
const TMP_WALLET = join(tmpdir(), `lualambda-wallet-test-${process.pid}.json`);

async function freshWallet(): Promise<typeof import('@/cli/wallet.ts')> {
  // Bun caches modules; append a unique query so config re-reads env each time.
  const mod = (await import(
    `@/cli/wallet.ts?t=${Math.random()}`
  )) as typeof import('@/cli/wallet.ts');
  return mod;
}

beforeEach(() => {
  process.env.LUALAMBDA_WALLET = TMP_WALLET;
  delete process.env.LUALAMBDA_MNEMONIC;
  if (existsSync(TMP_WALLET)) rmSync(TMP_WALLET);
});

afterEach(() => {
  if (existsSync(TMP_WALLET)) rmSync(TMP_WALLET);
  delete process.env.LUALAMBDA_WALLET;
  delete process.env.LUALAMBDA_MNEMONIC;
});

test('create writes a wallet file and address round-trips', async () => {
  const wallet = await freshWallet();
  const { address } = wallet.createWallet(false);
  expect(existsSync(TMP_WALLET)).toBe(true);
  expect(algosdk.isValidAddress(address)).toBe(true);
  expect(wallet.address()).toBe(address); // loadAccount round-trips the file
});

test('create refuses to overwrite without force, succeeds with force', async () => {
  const wallet = await freshWallet();
  const first = wallet.createWallet(false).address;
  expect(() => wallet.createWallet(false)).toThrow(/already exists/);
  const second = wallet.createWallet(true).address;
  expect(second).not.toBe(first); // force generated a new key
});

test('import writes the given mnemonic and yields its address', async () => {
  const wallet = await freshWallet();
  const generated = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(generated.sk);
  const { address } = wallet.importWallet(mnemonic, false);
  expect(address).toBe(generated.addr.toString());
});

test('LUALAMBDA_MNEMONIC overrides the wallet file', async () => {
  const wallet = await freshWallet();
  wallet.createWallet(false); // file has one key
  const other = algosdk.generateAccount();
  process.env.LUALAMBDA_MNEMONIC = algosdk.secretKeyToMnemonic(other.sk);
  expect(wallet.address()).toBe(other.addr.toString()); // env wins
});

test('signerKeyBase64 is the 64-byte secret key, base64', async () => {
  const wallet = await freshWallet();
  wallet.createWallet(false);
  const b64 = wallet.signerKeyBase64();
  expect(Buffer.from(b64, 'base64').length).toBe(64);
});
