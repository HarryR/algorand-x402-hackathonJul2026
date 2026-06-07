#!/usr/bin/env bun
/**
 * lualambda CLI.
 *
 *   lualambda invoke <id> --pkg ./hello --require hello --arg world --profile small
 *   lualambda invoke --pkg ./hello --require hello --arg world   # id auto-derived
 *   lualambda invoke < script.lua                                # raw Lua via stdin
 *   echo 'return 2 + 2' | lualambda invoke                       # quick one-liner
 *   lualambda status <id>
 *   lualambda output <id>
 *   lualambda profiles
 *   lualambda discover
 *   lualambda wallet create|status|address|qr|export|opt-in|import
 *
 * The idempotency id is opaque and client-chosen: pass it positionally (a hash
 * or a nametag), or omit it and the CLI derives a deterministic id from the
 * package hashes + require module + args. On `invoke`, `payingFetch` auto-handles
 * the x402 402 → sign (Algorand USDC) → retry dance; `--max-price` caps the spend.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from '@/shared/config.ts';
import { PROFILES, DEFAULT_PROFILE } from '@/shared/profiles.ts';
import type { InvokeOutput, InvokeStatus, InvokeDiscovery } from '@/shared/protocol.ts';
import { deriveId } from '@/shared/idempotency.ts';
import { assertValidRequire, ValidationError } from '@/shared/validate.ts';
import { baseUnitsToUsd } from '@/shared/units.ts';
import { resolvePackage, luaModulePackage, type PackageZip } from './zip.ts';
import { runLocal, runLocalSession } from '@/orchestrator/local.ts';
import { createSession } from '@/orchestrator/sessions.ts';
import type { SessionStart } from '@/shared/protocol.ts';
import { payingFetch, type PayTimings } from './payment.ts';
import { attachLocalSession, attachWebSocket, toWsUrl } from './serial.ts';
import * as wallet from './wallet.ts';
import { addressQr } from './qr.ts';

const USAGE = `lualambda — pay-per-run Lua packages on Algorand (x402)

Usage:
  lualambda invoke [<id>] [--pkg <dir|zip|file.lua> ...] [--require <module>]
                   [--arg <v> ...] [--profile nano|small|med] [--max-price <usd>]
                   [--verbose] [--attach] [--local-test [--keep] [--console]]
                   (prints only the result by default; -v/--verbose adds the id,
                    settlement receipt, and timing)
                   (--attach keeps the VM alive after running and drops you into a
                    Lua REPL on its serial; no --pkg = a bare REPL. Ctrl-] detaches.
                    Pairs with --local-test for a free local shell.)
                   (with no --pkg, reads a Lua script from stdin:
                      lualambda invoke < script.lua
                    a directory is zipped in-process; a .zip is uploaded verbatim;
                    a .lua file or piped Lua runs as the handler. --require defaults
                    to the module/file name; required only with multiple --pkg.)
                   (--local-test boots the package in a local QEMU VM — no server,
                    no payment, no wallet; needs qemu-system-x86_64 on PATH.
                    --keep retains the instance dir + boot.log for inspection;
                    --console streams the guest serial console live to stderr)
  lualambda attach <id>                            # attach a terminal to a running session
  lualambda serve [--port <n>] [--pay-to <addr>]   # run the orchestrator (HTTP API)
  lualambda status <id>
  lualambda output <id>
  lualambda profiles
  lualambda discover
  lualambda wallet create [--force]      # generate a testnet keypair
  lualambda wallet import <mnemonic> [--force]
  lualambda wallet status                # address + ALGO/USDC balances
  lualambda wallet address               # address + QR
  lualambda wallet qr                    # address + QR (for funding)
  lualambda wallet export                # print mnemonic + secret key (SECRET!)
  lualambda wallet opt-in                # opt into USDC for the active network (needs ALGO)

The id is opaque and client-chosen (a hash or a nametag). Omit it on invoke to
derive a deterministic id from the packages + module + args.

Global:
  --network testnet|mainnet   (default testnet; or LUALAMBDA_NETWORK)
  --workdir <dir>             (writable dir for --local-test; or LUALAMBDA_WORKDIR;
                               default ~/.local/share/lualambda)

Env:
  LUALAMBDA_ORCHESTRATOR_URL  (default ${config.orchestratorUrl})
  LUALAMBDA_WALLET / LUALAMBDA_MNEMONIC  (client Algorand key)
  active network: ${config.network}
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v != null ? [String(v)] : [];
}

/**
 * Top-level modules the guest ships as loose `pkg/*.lua` files. A user entry
 * module named one of these is SHADOWED by the guest's own file — most notably
 * `main`, the connect-back agent — so the stager's `require('main')` re-runs the
 * agent instead of the user's code (two agents fight over the network → no result
 * → timeout). Reject explicit collisions; remap inferred ones to SAFE_MODULE.
 */
const RESERVED_MODULES = new Set(['main', 'io', 'os']);
const SAFE_MODULE = 'app';

/** Coerce a string into a valid single-segment Lua module name (for synthetic packages). */
function sanitizeModuleName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!cleaned) return SAFE_MODULE;
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`; // require segments can't lead with a digit
}

/**
 * Resolve the package set + module to `require` from the flags. Supports raw Lua
 * so simple cases need no packaging:
 *   - no --pkg            → read a Lua chunk from stdin (must be piped)
 *   - --pkg <file.lua>    → that file is the Lua chunk
 *   - --pkg <dir|zip> ... → packaged mode (existing behavior)
 * Raw chunks are wrapped into a synthetic single-module package (luaModulePackage,
 * which makes bare scripts, value-returners, and full `function(args)` modules all
 * work). `--require` defaults to the synthetic module name in raw mode, or the
 * single package's basename in packaged mode; it's required only with multiple --pkg.
 */
async function resolveInvokeInputs(
  values: Record<string, unknown>,
): Promise<{ pkgs: PackageZip[]; requireMod: string }> {
  const pkgPaths = asArray(values.pkg);
  const luaFile =
    pkgPaths.length === 1 && pkgPaths[0]!.toLowerCase().endsWith('.lua') ? pkgPaths[0]! : undefined;

  // Raw Lua mode: source from a single .lua file, else piped stdin.
  if (pkgPaths.length === 0 || luaFile) {
    let source: string;
    let defaultMod: string;
    if (luaFile) {
      source = await readFile(luaFile, 'utf8').catch(() => die(`invoke: cannot read ${luaFile}`));
      defaultMod = sanitizeModuleName(basename(luaFile).replace(/\.lua$/i, ''));
    } else {
      if (process.stdin.isTTY) {
        die(
          'invoke: no --pkg given and stdin is a terminal.\n' +
            'Pipe a Lua script: lualambda invoke < script.lua   (or pass --pkg <dir|zip>)',
        );
      }
      source = await Bun.stdin.text();
      defaultMod = SAFE_MODULE;
    }
    if (!source.trim()) die('invoke: empty Lua source');
    let requireMod: string;
    if (values.require) {
      requireMod = sanitizeModuleName(String(values.require));
      if (RESERVED_MODULES.has(requireMod)) {
        die(
          `invoke: --require "${requireMod}" collides with a built-in guest module; pick another name`,
        );
      }
    } else {
      // Inferred (stdin default or .lua basename): the package is synthetic, so a
      // reserved name can be safely remapped rather than failing.
      requireMod = RESERVED_MODULES.has(defaultMod) ? SAFE_MODULE : defaultMod;
    }
    return { pkgs: [luaModulePackage(source, requireMod)], requireMod };
  }

  // Packaged mode. Unlike raw mode, a real package's name matches its in-zip
  // directory, so a reserved collision can't be silently remapped — fail clearly.
  const pkgs = await Promise.all(pkgPaths.map((p) => resolvePackage(p)));
  if (values.require) {
    const r = String(values.require);
    if (RESERVED_MODULES.has(r)) {
      die(`invoke: --require "${r}" collides with a built-in guest module; pick another name`);
    }
    return { pkgs, requireMod: r };
  }
  if (pkgs.length !== 1) {
    die('invoke: --require <module> is required when multiple --pkg are given\n\n' + USAGE);
  }
  // Infer require from the single package's basename — but only if it's a valid
  // Lua module name (stems allow dashes that `require` does not).
  const candidate = pkgs[0]!.name.replace(/\.zip$/i, '');
  try {
    assertValidRequire(candidate);
  } catch (e) {
    if (e instanceof ValidationError) {
      die(`invoke: couldn't infer --require from "${pkgs[0]!.name}" — pass --require <module>`);
    }
    throw e;
  }
  if (RESERVED_MODULES.has(candidate)) {
    die(
      `invoke: package "${pkgs[0]!.name}" collides with a built-in guest module ("${candidate}"); ` +
        `rename it or pass --require <module>`,
    );
  }
  return { pkgs, requireMod: candidate };
}

async function cmdInvoke(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const args = asArray(values.arg);
  const profile = String(values.profile ?? DEFAULT_PROFILE);
  const maxPrice = values['max-price'] ? Number(values['max-price']) : undefined;

  // Interactive: run (optionally a module), keep the VM alive, drop into a shell.
  if (values.attach) return cmdInvokeAttach(positionals, values, args, profile, maxPrice);

  const { pkgs, requireMod } = await resolveInvokeInputs(values);

  // Local dry-run: boot the package in a local QEMU VM via the shared core, no
  // server/payment. A faithful preview of a real invoke (same id/store/launch).
  if (values['local-test']) {
    return cmdInvokeLocal(pkgs, requireMod, args, profile, positionals[0], {
      keep: values.keep === true,
      console: values.console === true,
      verbose: values.verbose === true,
    });
  }

  const id =
    positionals[0] ??
    (await deriveId(
      pkgs.map((p) => p.bytes),
      requireMod,
      args,
    ));

  const form = new FormData();
  for (const p of pkgs) {
    form.append(
      'package',
      new Blob([new Uint8Array(p.bytes)], { type: 'application/zip' }),
      p.name,
    );
  }
  form.set('spec', JSON.stringify({ require: requireMod, args }));

  const timings: Partial<PayTimings> = {};
  const doFetch = payingFetch(maxPrice, timings);
  let res: Response;
  try {
    res = await doFetch(`${config.orchestratorUrl}/invoke/${encodeURIComponent(id)}/${profile}`, {
      method: 'POST',
      body: form,
    });
  } catch (e) {
    // Payment-side failures surface here: no wallet, or --max-price exceeded
    // (the selector aborts before signing).
    const msg = e instanceof Error ? e.message : String(e);
    die(/no wallet/i.test(msg) ? `${msg}` : `payment failed: ${msg}`);
  }
  if (res.status === 409) {
    const st = (await res.json()) as InvokeStatus;
    die(
      `already paid for id ${id} (profile=${st.paidProfile}); read it with: lualambda output ${id}`,
    );
  }
  if (!res.ok) die(`invoke failed (${res.status}): ${await res.text()}`);

  const out = (await res.json()) as InvokeOutput;
  // Default: print ONLY the result, so `… | jq` etc. get clean output. `--verbose`
  // adds the id, settlement receipt, and metering.
  const verbose = values.verbose === true;
  if (verbose) console.log(`id: ${id}`);
  console.log(JSON.stringify(out.result, null, 2));
  if (verbose) {
    if (out.receipt) console.log(`\nsettled: ${out.receipt.txid}\n${out.receipt.explorerUrl}`);
    const m = out.metering;
    if (timings.paidMs !== undefined) {
      // Paid path: report the x402-payment→VM-response e2e latency (the key
      // serverless metric) with the server-side settle vs. VM breakdown.
      const settle = m.settleMs !== undefined ? `settle ${Math.round(m.settleMs)}ms · ` : '';
      console.log(
        `\ne2e: ${Math.round(timings.paidMs)}ms payment→response  ` +
          `(${settle}vm ${m.vmWallMs}ms)  profile=${m.profile}`,
      );
    } else {
      // Free path (no 402): just the VM wall-clock.
      console.log(`\n(${m.profile}, ${m.vmWallMs}ms)`);
    }
  }
}

/**
 * `invoke --local-test`: boot the package in a local QEMU VM via the shared
 * runLocal core — no orchestrator, no payment, no wallet. A faithful preview of a
 * real invoke. By default the instance dir is removed after printing; `--keep`
 * (and any failure) leaves it so its boot.log can be inspected.
 */
async function cmdInvokeLocal(
  pkgs: PackageZip[],
  requireMod: string,
  args: string[],
  profile: string,
  id: string | undefined,
  opts: { keep: boolean; console: boolean; verbose: boolean },
): Promise<void> {
  // --console streams the guest serial console live to stderr as it boots, so a
  // failing/hanging boot is visible without digging into boot.log afterwards.
  const onSerial = opts.console ? (chunk: Uint8Array) => process.stderr.write(chunk) : undefined;

  const res = await runLocal({
    packages: pkgs.map((p) => ({ name: p.name, bytes: p.bytes })),
    require: requireMod,
    args,
    profileName: profile,
    id,
    onSerial,
  });

  if (!res.output.ok) {
    console.error(`local-test failed: ${res.output.error ?? 'guest produced no result'}`);
    // Surface the tail of the serial log inline (unless it was already streamed),
    // so the reason is visible without opening the file.
    if (!opts.console) await printBootLogTail(`${res.instanceDir}/boot.log`);
    console.error(`boot log: ${res.instanceDir}/boot.log`);
    process.exitCode = 1;
    return; // keep the dir on failure for debugging
  }

  if (opts.verbose) console.log(`id: ${res.id}`);
  console.log(JSON.stringify(res.output.result, null, 2));
  if (opts.verbose) console.log(`\n(${profile}, ${res.vmWallMs}ms, local)`);
  if (opts.keep) console.log(`instance: ${res.instanceDir}`);
  else await res.cleanup();
}

/** Print the last `n` lines of a boot.log to stderr (best-effort; missing → skip). */
async function printBootLogTail(path: string, n = 30): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => '');
  if (!text) return;
  const lines = text.split('\n');
  console.error(`--- boot.log (last ${n} lines) ---`);
  console.error(lines.slice(-n).join('\n'));
  console.error('--- end boot.log ---');
}

/** Short random hex id for ad-hoc interactive sessions (`sh-…`, FS/path-safe). */
function randomHex(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * `invoke --attach`: boot a VM, optionally run a module, then keep it alive and
 * bridge your terminal to a Lua REPL on its serial. `--local-test` runs the VM
 * locally (free, no server); otherwise it's a paid session on the orchestrator.
 * With no `--pkg`, you get a bare REPL (no stdin is read — you're going
 * interactive). Ctrl-] detaches.
 */
async function cmdInvokeAttach(
  positionals: string[],
  values: Record<string, unknown>,
  args: string[],
  profileName: string,
  maxPrice: number | undefined,
): Promise<void> {
  // Only run a module when a package is given; otherwise a bare REPL.
  let pkgs: PackageZip[] = [];
  let requireMod = '';
  if (asArray(values.pkg).length) ({ pkgs, requireMod } = await resolveInvokeInputs(values));
  const id = positionals[0] ?? `sh-${randomHex(8)}`;

  if (values['local-test']) {
    const sess = await runLocalSession({
      packages: pkgs.map((p) => ({ name: p.name, bytes: p.bytes })),
      require: requireMod,
      args,
      profileName,
      id,
    });
    const session = createSession(sess.id, sess.channel, {
      maxWallMs: sess.maxWallMs,
      maxOutputBytes: sess.maxOutputBytes,
    });
    console.error(`attached to local VM "${sess.id}" — Ctrl-] to detach (stops it)`);
    await attachLocalSession(session);
    await sess.cleanup();
    return;
  }

  // Remote: pay for + start a session, then attach over the serial WebSocket.
  const form = new FormData();
  for (const p of pkgs) {
    form.append(
      'package',
      new Blob([new Uint8Array(p.bytes)], { type: 'application/zip' }),
      p.name,
    );
  }
  if (requireMod) form.set('spec', JSON.stringify({ require: requireMod, args }));

  const doFetch = payingFetch(maxPrice, {});
  let res: Response;
  try {
    res = await doFetch(
      `${config.orchestratorUrl}/invoke/${encodeURIComponent(id)}/${profileName}?mode=session`,
      { method: 'POST', body: form },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    die(/no wallet/i.test(msg) ? msg : `payment failed: ${msg}`);
  }
  if (res.status === 409) {
    die(`id "${id}" already has a live session; join it with: lualambda attach ${id}`);
  }
  if (!res.ok) die(`session start failed (${res.status}): ${await res.text()}`);
  const info = (await res.json()) as SessionStart;
  console.error(`session "${id}" up — Ctrl-] to detach (it keeps running)`);
  await attachWebSocket(toWsUrl(config.orchestratorUrl, info.serial));
}

/** `attach <id>`: bridge your terminal to an already-running session's serial. */
async function cmdAttach(positionals: string[]): Promise<void> {
  const id = positionals[0];
  if (!id) die('attach: missing <id>');
  console.error(`attaching to "${id}" — Ctrl-] to detach`);
  await attachWebSocket(
    toWsUrl(config.orchestratorUrl, `/invoke/${encodeURIComponent(id)}/serial`),
  );
}

async function cmdStatus(positionals: string[]): Promise<void> {
  const id = positionals[0];
  if (!id) die('status: missing <id>');
  const res = await fetch(`${config.orchestratorUrl}/invoke/${encodeURIComponent(id)}`);
  if (!res.ok) die(`status failed (${res.status}): ${await res.text()}`);
  console.log(JSON.stringify((await res.json()) as InvokeStatus, null, 2));
}

async function cmdOutput(positionals: string[]): Promise<void> {
  const id = positionals[0];
  if (!id) die('output: missing <id>');
  const res = await fetch(`${config.orchestratorUrl}/invoke/${encodeURIComponent(id)}/output`);
  if (res.status === 410) die(`output for ${id} has expired`);
  if (!res.ok) die(`output failed (${res.status}): ${await res.text()}`);
  const out = (await res.json()) as InvokeOutput;
  console.log(JSON.stringify(out.result, null, 2));
}

function cmdProfiles(): void {
  for (const p of Object.values(PROFILES)) {
    console.log(
      `${p.name.padEnd(6)} ${String(p.memoryMiB).padStart(4)}MiB  cpu=${p.cpu.padEnd(9)} ` +
        `disk=${String(p.diskMiB).padStart(4)}MiB  ${p.bandwidthMbps}Mbps  ` +
        `retain=${p.retainSeconds}s  ${p.price}`,
    );
  }
}

async function cmdDiscover(): Promise<void> {
  const res = await fetch(`${config.orchestratorUrl}/invoke`);
  if (!res.ok) die(`discover failed (${res.status}): ${await res.text()}`);
  console.log(JSON.stringify((await res.json()) as InvokeDiscovery, null, 2));
}

async function cmdWallet(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const sub = positionals[0] ?? 'status';
  const force = values.force === true;
  switch (sub) {
    case 'create': {
      const { address } = wallet.createWallet(force);
      console.log(`created wallet: ${address}`);
      console.log(`  saved to ${config.walletPath}`);
      console.log(await addressQr(address));
      console.log('  fund ALGO:  https://lora.algokit.io/testnet/fund');
      console.log('  fund USDC:  https://faucet.circle.com/');
      console.log('  then:       lualambda wallet opt-in');
      return;
    }
    case 'import': {
      const mnemonic = values.mnemonic
        ? String(values.mnemonic)
        : positionals.slice(1).join(' ').trim();
      if (!mnemonic) die('wallet import: provide the 25-word mnemonic (or --mnemonic "...")');
      const { address } = wallet.importWallet(mnemonic, force);
      console.log(`imported wallet: ${address}`);
      return;
    }
    case 'address': {
      const addr = wallet.address();
      console.log(addr);
      return;
    }
    case 'qr': {
      const addr = wallet.address();
      console.log(await addressQr(addr));
      return;
    }
    case 'export': {
      const s = wallet.exportSecrets();
      // Secrets go to stdout (so they can be piped); the warning goes to stderr.
      console.error(
        '⚠ SECRET KEY MATERIAL — anyone with this controls the wallet. Never share or log it.',
      );
      console.log(`address:     ${s.address}`);
      console.log(`mnemonic:    ${s.mnemonic}`);
      console.log(`sk (base64): ${s.secretKeyBase64}`);
      console.log(`sk (hex):    ${s.secretKeyHex}`);
      return;
    }
    case 'status': {
      const b = await wallet.getBalances();
      console.log(`address: ${wallet.address()}`);
      console.log(`ALGO:    ${baseUnitsToUsd(b.algo)}`);
      console.log(`USDC:    ${b.optedIn ? baseUnitsToUsd(b.usdc!) : 'not opted in'}`);
      if (b.algo === 0n) console.log('  fund ALGO: https://lora.algokit.io/testnet/fund');
      if (!b.optedIn) console.log('  opt into USDC: lualambda wallet opt-in');
      else if (b.usdc === 0n) console.log('  fund USDC: https://faucet.circle.com/');
      return;
    }
    case 'opt-in': {
      const { txid } = await wallet.optIn();
      console.log(`opted into USDC (ASA ${config.usdcAsaId})`);
      console.log(`  tx: ${config.explorerTxBase}/${txid}`);
      return;
    }
    default:
      die(`wallet: unknown subcommand "${sub}" (create|import|address|qr|status|export|opt-in)`);
  }
}

/**
 * Run the CLI. `--network` is consumed by the entry shim (src/cli/main.ts) before
 * config loads, so it's accepted-and-ignored here.
 */
export async function run(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      pkg: { type: 'string', multiple: true },
      require: { type: 'string' },
      arg: { type: 'string', multiple: true },
      profile: { type: 'string' },
      'max-price': { type: 'string' },
      'local-test': { type: 'boolean' }, // run the VM locally; no server/payment
      keep: { type: 'boolean' }, // keep the local-test instance dir for inspection
      console: { type: 'boolean' }, // stream the guest serial console live (local-test)
      attach: { type: 'boolean' }, // keep the VM alive and drop into a serial shell
      verbose: { type: 'boolean', short: 'v' }, // print id + metering + receipt, not just the result
      force: { type: 'boolean' },
      mnemonic: { type: 'string' },
      network: { type: 'string' }, // handled by the entry shim; accepted here
      workdir: { type: 'string' }, // handled by the entry shim; accepted here
    },
  });

  switch (command) {
    case 'invoke':
      return cmdInvoke(positionals, values);
    case 'attach':
      return cmdAttach(positionals);
    case 'status':
      return cmdStatus(positionals);
    case 'output':
      return cmdOutput(positionals);
    case 'profiles':
      return cmdProfiles();
    case 'discover':
      return cmdDiscover();
    case 'wallet':
      return cmdWallet(positionals, values);
    default:
      die(`unknown command "${command}"\n\n` + USAGE);
  }
}
