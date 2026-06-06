#!/usr/bin/env bun
/**
 * lualambda CLI.
 *
 *   lualambda invoke <id> --pkg ./hello --require hello --arg world --profile small
 *   lualambda invoke --pkg ./hello --require hello --arg world   # id auto-derived
 *   lualambda status <id>
 *   lualambda output <id>
 *   lualambda profiles
 *   lualambda discover
 *   lualambda wallet status
 *
 * The idempotency id is opaque and client-chosen: pass it positionally (a hash
 * or a nametag), or omit it and the CLI derives a deterministic id from the
 * package hashes + require module + args. On `invoke`, Milestone 2 swaps the
 * plain fetch for `wrapFetchWithPayment` (@x402/fetch) so the 402 → sign →
 * retry-with-X-PAYMENT dance is automatic. The seam is `payingFetch()` below.
 */

import { parseArgs } from 'node:util';
import { config } from '@/shared/config.ts';
import { PROFILES, DEFAULT_PROFILE } from '@/shared/profiles.ts';
import type { InvokeOutput, InvokeStatus, InvokeDiscovery } from '@/shared/protocol.ts';
import { deriveId } from '@/shared/idempotency.ts';
import { resolvePackage } from './zip.ts';

const USAGE = `lualambda — pay-per-run Lua packages on Algorand (x402)

Usage:
  lualambda invoke [<id>] --pkg <dir|zip> [--pkg <dir|zip> ...] --require <module>
                   [--arg <v> ...] [--profile nano|small|med] [--max-price <usd>]
                   (a directory is zipped in-process; a .zip is uploaded verbatim)
  lualambda status <id>
  lualambda output <id>
  lualambda profiles
  lualambda discover
  lualambda wallet status

The id is opaque and client-chosen (a hash or a nametag). Omit it on invoke to
derive a deterministic id from the packages + module + args.

Env:
  LUALAMBDA_ORCHESTRATOR_URL  (default ${config.orchestratorUrl})
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * The payment seam. Today: a plain fetch (works against the unpaid Milestone-1
 * orchestrator). Milestone 2: wrap with `wrapFetchWithPayment(fetch, signer)`
 * so a 402 is auto-handled, with `maxPrice` as the client-side ceiling.
 */
function payingFetch(_maxPrice?: number): typeof fetch {
  return fetch;
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v != null ? [String(v)] : [];
}

async function cmdInvoke(positionals: string[], values: Record<string, unknown>): Promise<void> {
  const pkgPaths = asArray(values.pkg);
  if (pkgPaths.length === 0) die('invoke: need at least one --pkg <dir|zip>\n\n' + USAGE);
  const requireMod = values.require ? String(values.require) : undefined;
  if (!requireMod) die('invoke: --require <module> is required\n\n' + USAGE);

  const args = asArray(values.arg);
  const profile = String(values.profile ?? DEFAULT_PROFILE);
  const maxPrice = values['max-price'] ? Number(values['max-price']) : undefined;

  const pkgs = await Promise.all(pkgPaths.map((p) => resolvePackage(p)));
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

  const doFetch = payingFetch(maxPrice);
  const res = await doFetch(
    `${config.orchestratorUrl}/invoke/${encodeURIComponent(id)}/${profile}`,
    {
      method: 'POST',
      body: form,
    },
  );
  if (res.status === 409) {
    const st = (await res.json()) as InvokeStatus;
    die(
      `already paid for id ${id} (profile=${st.paidProfile}); read it with: lualambda output ${id}`,
    );
  }
  if (!res.ok) die(`invoke failed (${res.status}): ${await res.text()}`);

  const out = (await res.json()) as InvokeOutput;
  console.log(`id: ${id}`);
  console.log(JSON.stringify(out.result, null, 2));
  if (out.receipt) console.log(`\nsettled: ${out.receipt.txid}\n${out.receipt.explorerUrl}`);
  console.log(`\n(${out.metering.profile}, ${out.metering.vmWallMs}ms)`);
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

function cmdWallet(positionals: string[]): void {
  const sub = positionals[0] ?? 'status';
  if (sub !== 'status') die(`wallet: unknown subcommand "${sub}"`);
  console.log('wallet status: not wired yet (Milestone 2 — Algorand testnet key + USDC balance).');
}

async function main(): Promise<void> {
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
    },
  });

  switch (command) {
    case 'invoke':
      return cmdInvoke(positionals, values);
    case 'status':
      return cmdStatus(positionals);
    case 'output':
      return cmdOutput(positionals);
    case 'profiles':
      return cmdProfiles();
    case 'discover':
      return cmdDiscover();
    case 'wallet':
      return cmdWallet(positionals);
    default:
      die(`unknown command "${command}"\n\n` + USAGE);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
