/**
 * Runtime configuration, read from the environment.
 *
 * Defaults target the in-container dev setup (local orchestrator, Algorand
 * testnet, managed GoPlausible facilitator). Never hardcode keys here — those
 * come from .env (gitignored) or a throwaway testnet key generated in-container.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getNetwork, DEFAULT_NETWORK } from './networks.ts';

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Resolve the single writable working directory that holds everything the
 * orchestrator/CLI persist (pkg/, instances/<id>/, runtime/vmlinux). Precedence:
 *   LUALAMBDA_WORKDIR  (canonical override)
 *   LUALAMBDA_DATA_DIR (back-compat: the old name for this dir)
 *   $XDG_DATA_HOME/lualambda, else ~/.local/share/lualambda  (XDG default)
 * Pure (takes an env bag) so it's unit-testable without re-importing config.
 */
export function resolveWorkDir(e: Record<string, string | undefined> = process.env): string {
  const xdgDataHome = e.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return e.LUALAMBDA_WORKDIR ?? e.LUALAMBDA_DATA_DIR ?? join(xdgDataHome, 'lualambda');
}

// Network selection (default testnet). The USDC ASA id + CAIP-2 are hardcoded
// per-network protocol constants from the bundle; only payTo is operator config.
const network = getNetwork(env('LUALAMBDA_NETWORK', DEFAULT_NETWORK));
const usdcAsaId = network.usdcAsaId;
const payToAddress = env('LUALAMBDA_PAY_TO', '');

export const config = {
  /** Where the orchestrator listens / the CLI points. */
  orchestratorUrl: env('LUALAMBDA_ORCHESTRATOR_URL', 'http://localhost:8402'),
  orchestratorPort: Number(env('LUALAMBDA_PORT', '8402')),

  /**
   * The single writable working directory: holds pkg/, instances/<id>/ (each
   * with initrd.zip + data.img + boot.log), and runtime/vmlinux. Set with
   * LUALAMBDA_WORKDIR (LUALAMBDA_DATA_DIR honored as a back-compat alias);
   * defaults to ~/.local/share/lualambda. See resolveWorkDir.
   */
  workDir: resolveWorkDir(),

  // --- x402 / Algorand ------------------------------------------------------

  /** Selected network ("testnet" | "mainnet"); default testnet. */
  network: network.name,
  /** CAIP-2 network id (from the network bundle). */
  algorandNetwork: network.caip2,
  /** Managed facilitator (GoPlausible); shared across networks (routes by CAIP-2). */
  facilitatorUrl: env('LUALAMBDA_FACILITATOR_URL', 'https://facilitator.goplausible.xyz'),
  /** USDC ASA id — hardcoded per-network protocol constant (not env). */
  usdcAsaId,
  /**
   * Address that RECEIVES payments. Must be opted into the USDC ASA to hold it.
   * The orchestrator holds no key — it only builds requirements + calls the
   * facilitator (which fee-sponsors). Payments are gated on this being set.
   */
  payToAddress,
  /**
   * Payments are enforced only when payTo is set (the USDC ASA is always known
   * from the network bundle); otherwise the orchestrator runs free, preserving
   * the dev/E2E path.
   */
  paymentsEnabled: payToAddress !== '',

  /** Algod endpoint for wallet balance / opt-in (network default, env-overridable). */
  algodUrl: env('LUALAMBDA_ALGOD_URL', network.algodUrl),
  /**
   * Client wallet file. `LUALAMBDA_MNEMONIC` overrides it. Testnet throwaway
   * keys only when on testnet.
   */
  walletPath: env('LUALAMBDA_WALLET', join(homedir(), '.config', 'lualambda', 'wallet.json')),
  /** Explorer tx URL prefix for settlement receipts: `${base}/${txid}` (network default). */
  explorerTxBase: env('LUALAMBDA_EXPLORER_TX_BASE', network.explorerTxBase),

  // --- QEMU / guest (Milestone 0) -------------------------------------------

  // The kernel (vmlinux) + initrd template + overlay are embedded in the binary
  // and resolved by src/orchestrator/artifacts.ts (which honors LUALAMBDA_KERNEL
  // / LUALAMBDA_INITRD_TEMPLATE overrides) — not read from config here.

  /** QEMU binary; machine type (q35 gives PCI for virtio-net + NVMe). */
  qemuBinary: env('LUALAMBDA_QEMU', 'qemu-system-x86_64'),
  qemuMachine: env('LUALAMBDA_QEMU_MACHINE', 'q35'),
  /**
   * Use hardware virtualization when /dev/kvm is available. In the dev
   * container we default to TCG (off); the packaged orchestrator flips this on.
   */
  qemuKvm: env('LUALAMBDA_QEMU_KVM', '') === '1',

  /**
   * Per-instance connect-back ports are allocated from this inclusive range on
   * the host loopback; one listener per running VM.
   */
  portRangeStart: Number(env('LUALAMBDA_PORT_RANGE_START', '24000')),
  portRangeEnd: Number(env('LUALAMBDA_PORT_RANGE_END', '24999')),

  // Boot logs are written per-instance to <workDir>/instances/<id>/boot.log.

  // --- Upload limits (untrusted input; enforced at the API boundary) --------

  /** Max package zips per invocation. */
  maxPackagesPerInvoke: Number(env('LUALAMBDA_MAX_PACKAGES', '10')),
  /** Max aggregate uploaded package bytes per invocation (default 200 MiB). */
  maxUploadBytes: Number(env('LUALAMBDA_MAX_UPLOAD_BYTES', String(200 * 1024 * 1024))),
} as const;

export type Config = typeof config;
