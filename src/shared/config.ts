/**
 * Runtime configuration, read from the environment.
 *
 * Defaults target the in-container dev setup (local orchestrator, Algorand
 * testnet, managed GoPlausible facilitator). Never hardcode keys here — those
 * come from .env (gitignored) or a throwaway testnet key generated in-container.
 */

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  /** Where the orchestrator listens / the CLI points. */
  orchestratorUrl: env('LUALAMBDA_ORCHESTRATOR_URL', 'http://localhost:8402'),
  orchestratorPort: Number(env('LUALAMBDA_PORT', '8402')),

  /** On-disk store for deployed function bundles. */
  dataDir: env('LUALAMBDA_DATA_DIR', '.lualambda/data'),

  // --- x402 / Algorand (wired in Milestone 2) -------------------------------

  /** CAIP-2 network id for Algorand testnet. */
  algorandNetwork: env(
    'LUALAMBDA_ALGORAND_NETWORK',
    'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
  ),
  /** Managed facilitator; self-hosting is a stretch goal. */
  facilitatorUrl: env('LUALAMBDA_FACILITATOR_URL', 'https://facilitator.goplausible.xyz'),
  /** Testnet USDC ASA id — confirm from the docs before relying on it. */
  usdcAsaId: env('LUALAMBDA_USDC_ASA_ID', ''),
  /** Address that receives payments (the orchestrator's AVM address). */
  payToAddress: env('LUALAMBDA_PAY_TO', ''),

  // --- QEMU / guest ---------------------------------------------------------

  /** PVH kernel image (MicroNT vmlinux). Set once the spike has artifacts. */
  kernelPath: env('LUALAMBDA_KERNEL', ''),
  qemuBinary: env('LUALAMBDA_QEMU', 'qemu-system-x86_64'),
} as const;

export type Config = typeof config;
