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
 *   lualambda wallet create|status|address|qr|opt-in|import
 *
 * The idempotency id is opaque and client-chosen: pass it positionally (a hash
 * or a nametag), or omit it and the CLI derives a deterministic id from the
 * package hashes + require module + args. On `invoke`, `payingFetch` auto-handles
 * the x402 402 → sign (Algorand USDC) → retry dance; `--max-price` caps the spend.
 */

import { parseArgs } from 'node:util';
import { config } from '@/shared/config.ts';
import { PROFILES, DEFAULT_PROFILE } from '@/shared/profiles.ts';
import type { InvokeOutput, InvokeStatus, InvokeDiscovery } from '@/shared/protocol.ts';
import { deriveId } from '@/shared/idempotency.ts';
import { baseUnitsToUsd } from '@/shared/units.ts';
import { resolvePackage } from './zip.ts';
import { payingFetch } from './payment.ts';
import * as wallet from './wallet.ts';
import { addressQr } from './qr.ts';

const USAGE = `lualambda — pay-per-run Lua packages on Algorand (x402)

Usage:
  lualambda invoke [<id>] --pkg <dir|zip> [--pkg <dir|zip> ...] --require <module>
                   [--arg <v> ...] [--profile nano|small|med] [--max-price <usd>]
                   (a directory is zipped in-process; a .zip is uploaded verbatim)
  lualambda status <id>
  lualambda output <id>
  lualambda profiles
  lualambda discover
  lualambda wallet create [--force]      # generate a testnet keypair
  lualambda wallet import <mnemonic> [--force]
  lualambda wallet status                # address + ALGO/USDC balances
  lualambda wallet address               # address + QR
  lualambda wallet qr                    # address + QR (for funding)
  lualambda wallet opt-in                # opt into testnet USDC (needs ALGO)

The id is opaque and client-chosen (a hash or a nametag). Omit it on invoke to
derive a deterministic id from the packages + module + args.

Global:
  --network testnet|mainnet   (default testnet; or LUALAMBDA_NETWORK)

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
      die(`wallet: unknown subcommand "${sub}" (create|import|address|qr|status|opt-in)`);
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
      force: { type: 'boolean' },
      mnemonic: { type: 'string' },
      network: { type: 'string' }, // handled by the entry shim; accepted here
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
      return cmdWallet(positionals, values);
    default:
      die(`unknown command "${command}"\n\n` + USAGE);
  }
}
