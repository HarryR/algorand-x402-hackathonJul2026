#!/usr/bin/env bun
/**
 * lualambda entry shim — the single all-in-one binary.
 *
 * One executable is client, wallet, AND orchestrator. The first positional picks
 * the role: `serve` (aka `orchestrator`) boots the HTTP server; everything else is
 * a CLI command (invoke/status/wallet/…) handled by ./run.ts.
 *
 * Both roles import config.ts, which reads its env (LUALAMBDA_NETWORK, _WORKDIR,
 * _PORT, _PAY_TO) AT IMPORT TIME — so this shim must pre-parse the relevant flags
 * and set the env BEFORE dynamically importing either role. Hence the shim: parse
 * globals, set env, then import the chosen entrypoint.
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

// First positional = the role/command. Global flags (--network/--workdir, and the
// serve-only --port/--pay-to) may precede it, so skip flags and their values.
function firstPositional(args: string[]): string | undefined {
  const valueFlags = new Set(['--network', '--workdir', '--port', '--pay-to']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.has(a)) {
      i++; // skip the flag's value too
      continue;
    }
    if (a.startsWith('-')) continue; // --x=y form or a bare boolean flag
    return a;
  }
  return undefined;
}

const command = firstPositional(argv);

// Import AFTER the env is set so config picks up the selected network/role config.
if (command === 'serve' || command === 'orchestrator') {
  // Orchestrator role. It reads its config (port, payTo, …) from env and starts
  // Bun.serve at module top level, so importing it boots the server. Surface the
  // two most common knobs as flags for convenience.
  const port = flag('port');
  if (port) process.env.LUALAMBDA_PORT = port;
  const payTo = flag('pay-to');
  if (payTo) process.env.LUALAMBDA_PAY_TO = payTo;
  import('../orchestrator/server.ts').catch((e) => die(e instanceof Error ? e.message : String(e)));
} else {
  import('./run.ts')
    .then((m) => m.run())
    .catch((e) => die(e instanceof Error ? e.message : String(e)));
}
