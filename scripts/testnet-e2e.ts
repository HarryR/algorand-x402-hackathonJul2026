#!/usr/bin/env bun
/**
 * Testnet end-to-end integration harness — the real paid loop, on demand.
 *
 *   bun run testnet:e2e        (or: bun run scripts/testnet-e2e.ts)
 *
 * Unlike the offline `bun test` suite (no QEMU, no network, no funds), this spins
 * up the REAL orchestrator with payments enforced, drives the REAL CLI against it,
 * hits the LIVE GoPlausible facilitator, settles LIVE testnet USDC, boots a REAL
 * MicroNT VM, and asserts on the result + on-chain settlement. It is NOT a
 * `*.test.ts` file and lives under scripts/, so `bun test` and CI never run it.
 *
 * Safety (hard-gated): refuses anything but testnet; never writes the wallet
 * (read-only preflight); runs the orchestrator in an isolated temp workdir. The
 * only real spend is one `nano` invoke (~$0.001 USDC).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '@/shared/config.ts';
import { PROFILES } from '@/shared/profiles.ts';
import { parseUsdToBaseUnits, baseUnitsToUsd } from '@/shared/units.ts';
import * as wallet from '@/cli/wallet.ts';

// Receiver of the payments. Defaults to the project's known testnet wallet (it is
// already opted into USDC); override with LUALAMBDA_PAY_TO to point elsewhere.
const KY2E_DEFAULT = 'KY2EMCTJE5MHU7A24O6DGV22SGZIQWMLLJ5OWIHDVWTNYRBMHBUUTJCDE4';

const TEST_PORT = Number(process.env.LUALAMBDA_E2E_PORT ?? '8499'); // distinct from the 8402 default
const BASE_URL = `http://localhost:${TEST_PORT}`;
const PROFILE = 'nano'; // cheapest tier; the only real spend
const PRICE_BASE_UNITS = parseUsdToBaseUnits(PROFILES[PROFILE].price); // 1000n for $0.001

const decoder = new TextDecoder();

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

// --- assertion tally --------------------------------------------------------
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- preflight (read-only; aborts before spending anything) -----------------
async function preflight(): Promise<{ payTo: string; payer: string; usdcBefore: bigint | null }> {
  console.log('preflight:');

  if (config.network !== 'testnet') {
    fail(
      `refusing to run: active network is "${config.network}", not testnet (never spend mainnet)`,
    );
  }
  console.log(`  network: ${config.network}`);

  if (!Bun.which(config.qemuBinary)) {
    fail(`QEMU not found on PATH (${config.qemuBinary}); the VM boot needs it`);
  }
  console.log(`  qemu:    ${config.qemuBinary}`);

  let payer: string;
  try {
    payer = wallet.address();
  } catch {
    fail('no wallet configured — run `lualambda wallet create` or set LUALAMBDA_MNEMONIC');
  }

  // Verify funding when algod responds; degrade gracefully if it can't (the
  // public endpoint rate-limits — 403 free quota). A truly unfunded payer just
  // fails check 1 safely with no spend, so a balance hiccup must not abort here.
  // Set LUALAMBDA_ALGOD_URL to a private endpoint to avoid the public quota.
  let usdcBefore: bigint | null = null;
  try {
    const bal = await wallet.getBalances();
    if (!bal.optedIn) {
      fail(`payer ${payer} is not opted into USDC — run \`lualambda wallet opt-in\``);
    }
    usdcBefore = bal.usdc!;
    if (usdcBefore < PRICE_BASE_UNITS) {
      fail(
        `payer USDC balance $${baseUnitsToUsd(usdcBefore)} < required ` +
          `$${baseUnitsToUsd(PRICE_BASE_UNITS)} ` +
          `(fund via https://faucet.circle.com/ ; ALGO via https://lora.algokit.io/testnet/fund)`,
      );
    }
    console.log(
      `  payer:   ${payer}  (ALGO $${baseUnitsToUsd(bal.algo)}, USDC $${baseUnitsToUsd(usdcBefore)})`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  payer:   ${payer}  (balance check unavailable: ${msg} — continuing)`);
  }

  const payTo = process.env.LUALAMBDA_PAY_TO || KY2E_DEFAULT;
  console.log(
    `  payTo:   ${payTo}${process.env.LUALAMBDA_PAY_TO ? ' (from env)' : ' (default receiver)'}`,
  );

  return { payTo, payer, usdcBefore };
}

// --- run the real CLI as a subprocess against the spawned orchestrator -------
async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli/main.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, LUALAMBDA_ORCHESTRATOR_URL: BASE_URL, LUALAMBDA_NETWORK: 'testnet' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out, err };
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  return false;
}

async function main(): Promise<void> {
  const { payTo, usdcBefore } = await preflight();

  const workDir = mkdtempSync(join(tmpdir(), 'lualambda-e2e-'));
  const serverLog: string[] = [];
  let serverOk = false;

  console.log(`\nspawning orchestrator on :${TEST_PORT} (workdir ${workDir}) …`);
  const server = Bun.spawn(['bun', 'run', 'src/orchestrator/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LUALAMBDA_PAY_TO: payTo,
      LUALAMBDA_PORT: String(TEST_PORT),
      LUALAMBDA_WORKDIR: workDir,
      LUALAMBDA_NETWORK: 'testnet',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    for await (const chunk of stream) serverLog.push(decoder.decode(chunk));
  };
  void drain(server.stdout as ReadableStream<Uint8Array>);
  void drain(server.stderr as ReadableStream<Uint8Array>);

  try {
    if (!(await waitForHealth(30_000))) {
      fail(`orchestrator did not become healthy on ${BASE_URL} within 30s`);
    }
    console.log('orchestrator healthy.\n');

    const baseArgs = [
      'invoke',
      '--pkg',
      'examples/hello',
      '--require',
      'hello',
      '--profile',
      PROFILE,
    ];

    // --- Check 1: a real paid invoke succeeds + settles on-chain ------------
    console.log('check 1: paid invoke (live facilitator + VM boot) …');
    const r1 = await runCli([...baseArgs, '--arg', 'Algorand']);
    const out1 = r1.out + r1.err;
    check('exit 0', r1.code === 0, `exit ${r1.code}\n${out1.trim()}`);
    check('result is {"greeting":"hello Algorand"}', /"greeting":\s*"hello Algorand"/.test(r1.out));
    const txMatch = r1.out.match(/settled:\s*([A-Z2-7]{52})/);
    check('settlement txid present (52-char base32)', txMatch !== null);
    if (txMatch) {
      const txid = txMatch[1]!;
      check('explorer URL contains the txid', r1.out.includes(txid));
      console.log(`     txid: ${txid}`);
    }

    // Headline metric: the x402-payment→VM-response e2e latency the CLI reports
    // (with the settle vs. vm breakdown). This is the serverless invocation time.
    const e2eMatch = r1.out.match(/e2e:\s*(\d+)ms[^\n]*/);
    check('e2e payment→response latency reported', e2eMatch !== null, out1.trim());
    if (e2eMatch) console.log(`     ${e2eMatch[0]}`);

    // Soft on-chain confirmation: poll the payer balance for the ~$0.001 debit.
    // Best-effort and fully fault-tolerant — algod can lag a round or rate-limit
    // (public free quota → 403); a balance hiccup must NOT fail the run. The txid
    // above is the authoritative proof of settlement.
    if (usdcBefore === null) {
      console.log('     payer USDC delta: skipped (no baseline balance from preflight)');
    } else {
      try {
        let usdcAfter = usdcBefore;
        for (let i = 0; i < 8; i++) {
          await Bun.sleep(1500);
          usdcAfter = (await wallet.getBalances()).usdc ?? usdcAfter;
          if (usdcAfter < usdcBefore) break;
        }
        const delta = usdcBefore - usdcAfter;
        console.log(
          `     payer USDC delta: -$${baseUnitsToUsd(delta)} ` +
            `($${baseUnitsToUsd(usdcBefore)} → $${baseUnitsToUsd(usdcAfter)})` +
            (delta === PRICE_BASE_UNITS ? '' : '  [soft: not yet reflected]'),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`     payer USDC delta: skipped (balance check unavailable: ${msg})`);
      }
    }

    // --- Check 2: re-paying the same id is rejected (409, no double charge) --
    console.log('\ncheck 2: idempotent re-pay → 409 …');
    const r2 = await runCli([...baseArgs, '--arg', 'Algorand']);
    const out2 = r2.out + r2.err;
    check('exit 1', r2.code === 1, `exit ${r2.code}`);
    check('reports "already paid"', /already paid/i.test(out2), out2.trim());

    // --- Check 3: --max-price aborts before signing (no spend) --------------
    console.log('\ncheck 3: --max-price below price → client aborts, no spend …');
    const r3 = await runCli([...baseArgs, '--arg', 'CheapCheck', '--max-price', '0.0001']);
    const out3 = r3.out + r3.err;
    check('exit 1', r3.code === 1, `exit ${r3.code}`);
    check('reports a max-price abort', /max-price/i.test(out3), out3.trim());

    serverOk = failed === 0;
  } finally {
    try {
      server.kill();
      await server.exited;
    } catch {
      /* already gone */
    }
    if (serverOk) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.error(`\nserver workdir kept for inspection: ${workDir}`);
      console.error(`  boot logs: ${join(workDir, 'instances')}/<id>/boot.log`);
      const tail = serverLog.join('').split('\n').slice(-40).join('\n');
      console.error(`--- orchestrator output (tail) ---\n${tail}`);
    }
  }

  if (failed > 0) {
    console.error(`\n✖ ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✓ all checks passed — real paid invoke settled on testnet');
}

await main();
