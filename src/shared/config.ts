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

  // --- QEMU / guest (Milestone 0) -------------------------------------------

  /**
   * PVH loader ELF (MicroNT vmlinux). Required to actually boot a VM. Defaults
   * to the version-controlled vendored artifact; override in production.
   */
  kernelPath: env('LUALAMBDA_KERNEL', 'vendor/micront/vmlinux'),
  /**
   * Template initrd.zip (base system + baked-in agent pkg/main.lua). Per
   * instance we rebuild a copy with our overlay + the user's pkg/*.zip merged
   * in. Defaults to the version-controlled vendored artifact; override in prod.
   */
  initrdTemplatePath: env('LUALAMBDA_INITRD_TEMPLATE', 'vendor/micront/initrd.zip'),
  /** QEMU binary; machine type (q35 gives PCI for virtio-net + NVMe). */
  qemuBinary: env('LUALAMBDA_QEMU', 'qemu-system-x86_64'),
  qemuMachine: env('LUALAMBDA_QEMU_MACHINE', 'q35'),
  /**
   * Use hardware virtualization when /dev/kvm is available. In the dev
   * container we default to TCG (off); the packaged orchestrator flips this on.
   */
  qemuKvm: env('LUALAMBDA_QEMU_KVM', '') === '1',

  /** SLIRP gateway the guest dials back to (QEMU user-mode NAT). */
  slirpGateway: '10.0.2.2',
  /**
   * Per-instance connect-back ports are allocated from this inclusive range on
   * the host loopback; one listener per running VM.
   */
  portRangeStart: Number(env('LUALAMBDA_PORT_RANGE_START', '24000')),
  portRangeEnd: Number(env('LUALAMBDA_PORT_RANGE_END', '24999')),

  /** Where per-instance boot logs are archived. */
  bootLogDir: env('LUALAMBDA_BOOTLOG_DIR', '.lualambda/bootlogs'),
} as const;

export type Config = typeof config;
