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

// Extract --network and --workdir (`--x v` or `--x=v`) from argv without
// consuming anything else; run.ts re-parses the full argv (and accepts both as
// no-ops). Both must be set into env BEFORE config loads — config reads them at
// import time. --workdir matters for `invoke --local-test`, which boots a VM
// in-process and writes under the workdir.
const argv = Bun.argv.slice(2);
function flag(name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(`--${name}=`.length);
  }
  return undefined;
}

const network = flag('network');
if (network !== undefined) {
  if (network !== 'testnet' && network !== 'mainnet') {
    die(`--network must be "testnet" or "mainnet" (got "${network ?? ''}")`);
  }
  process.env.LUALAMBDA_NETWORK = network;
}

const workdir = flag('workdir');
if (workdir) process.env.LUALAMBDA_WORKDIR = workdir;

// Import AFTER the env is set so config picks up the selected network.
import('./run.ts')
  .then((m) => m.run())
  .catch((e) => die(e instanceof Error ? e.message : String(e)));
