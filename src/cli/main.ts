#!/usr/bin/env bun
/**
 * lualambda CLI entry shim.
 *
 * `--network testnet|mainnet` selects the Algorand network bundle (CAIP-2 + USDC
 * ASA + endpoints). config.ts reads LUALAMBDA_NETWORK at import time, so we must
 * resolve the flag and set the env var BEFORE importing config (or anything that
 * imports it). Hence this shim: pre-parse argv, set the env, then dynamically
 * import the real CLI. The implementation lives in ./run.ts.
 */

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Extract --network (`--network x` or `--network=x`) from argv without consuming
// anything else; run.ts re-parses the full argv (and accepts --network as a
// no-op). Env var, if already set, is the fallback default.
const argv = Bun.argv.slice(2);
let network: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--network') network = argv[i + 1];
  else if (a.startsWith('--network=')) network = a.slice('--network='.length);
}
if (network !== undefined) {
  if (network !== 'testnet' && network !== 'mainnet') {
    die(`--network must be "testnet" or "mainnet" (got "${network ?? ''}")`);
  }
  process.env.LUALAMBDA_NETWORK = network;
}

// Import AFTER the env is set so config picks up the selected network.
import('./run.ts')
  .then((m) => m.run())
  .catch((e) => die(e instanceof Error ? e.message : String(e)));
