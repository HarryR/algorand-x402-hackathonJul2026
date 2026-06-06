import { test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import algosdk from 'algosdk';
import * as wallet from '@/cli/wallet.ts';

// wallet.ts reads LUALAMBDA_WALLET live via walletPath(), so a plain import works
// and the env var fully controls the path — no module-cache tricks needed.
const TMP_WALLET = join(tmpdir(), `lualambda-wallet-test-${process.pid}.json`);

// Safety net: these tests create/overwrite wallet files. Never let that touch a
// real wallet under the user's home config dir, no matter what.
const REAL_WALLET_DIR = join(homedir(), '.config', 'lualambda');
function assertSafePath(): void {
  if (wallet.walletPath().startsWith(REAL_WALLET_DIR)) {
    throw new Error(`refusing to run wallet test against real wallet dir: ${wallet.walletPath()}`);
  }
}

beforeEach(() => {
  process.env.LUALAMBDA_WALLET = TMP_WALLET;
  delete process.env.LUALAMBDA_MNEMONIC;
  assertSafePath();
  if (existsSync(TMP_WALLET)) rmSync(TMP_WALLET);
});

afterEach(() => {
  if (existsSync(TMP_WALLET)) rmSync(TMP_WALLET);
  delete process.env.LUALAMBDA_WALLET;
  delete process.env.LUALAMBDA_MNEMONIC;
});

test('walletPath honors LUALAMBDA_WALLET (so tests never touch a real wallet)', () => {
  expect(wallet.walletPath()).toBe(TMP_WALLET);
});

test('create writes a wallet file and address round-trips', () => {
  const { address } = wallet.createWallet(false);
  expect(existsSync(TMP_WALLET)).toBe(true);
  expect(algosdk.isValidAddress(address)).toBe(true);
  expect(wallet.address()).toBe(address); // loadAccount round-trips the file
});

test('create refuses to overwrite without force, succeeds with force', () => {
  const first = wallet.createWallet(false).address;
  expect(() => wallet.createWallet(false)).toThrow(/already exists/);
  const second = wallet.createWallet(true).address;
  expect(second).not.toBe(first); // force generated a new key
});

test('import writes the given mnemonic and yields its address', () => {
  const generated = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(generated.sk);
  const { address } = wallet.importWallet(mnemonic, false);
  expect(address).toBe(generated.addr.toString());
});

test('LUALAMBDA_MNEMONIC overrides the wallet file', () => {
  wallet.createWallet(false); // file has one key
  const other = algosdk.generateAccount();
  process.env.LUALAMBDA_MNEMONIC = algosdk.secretKeyToMnemonic(other.sk);
  expect(wallet.address()).toBe(other.addr.toString()); // env wins
});

test('signerKeyBase64 is the 64-byte secret key, base64', () => {
  wallet.createWallet(false);
  const b64 = wallet.signerKeyBase64();
  expect(Buffer.from(b64, 'base64').length).toBe(64);
});
