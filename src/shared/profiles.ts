/**
 * Resource profiles → price tiers.
 *
 * Each profile maps a bundle of QEMU resource caps (memory, vCPU share, disk,
 * bandwidth) to an x402 price. The orchestrator enforces the caps; the x402
 * middleware charges the price. See OUTLINE.md "Resource profiles → price tiers".
 */

export type ProfileName = 'nano' | 'small' | 'med';

export interface ResourceProfile {
  name: ProfileName;
  /** QEMU `-m` value, in MiB. */
  memoryMiB: number;
  /**
   * vCPU policy. Enforced via cgroup `cpu.max` on the QEMU pid.
   *  - 'throttled': a small CPU share (sub-core).
   *  - 'shared':    one core, time-shared with other tenants.
   *  - 'full':      one dedicated core.
   */
  cpu: 'throttled' | 'shared' | 'full';
  /** Attached block image size, in MiB. */
  diskMiB: number;
  /** Userspace bandwidth throttle target, in Mbps (0 = unthrottled). */
  bandwidthMbps: number;
  /**
   * Maximum wall-clock the guest VM may run before the orchestrator kills it,
   * in milliseconds. On timeout the run errors and the boot log is archived.
   */
  maxWallMs: number;
  /**
   * How long the invocation output is retained and readable via
   * `GET /invoke/:id/output` after the run completes, in seconds.
   */
  retainSeconds: number;
  /** Maximum retained output size, in bytes. Larger outputs are truncated. */
  maxOutputBytes: number;
  /** x402 price string, e.g. "$0.005". */
  price: string;
}

export const PROFILES: Record<ProfileName, ResourceProfile> = {
  nano: {
    name: 'nano',
    memoryMiB: 64,
    cpu: 'throttled',
    diskMiB: 16,
    bandwidthMbps: 1,
    maxWallMs: 10_000,
    retainSeconds: 60,
    maxOutputBytes: 64 * 1024,
    price: '$0.001',
  },
  small: {
    name: 'small',
    memoryMiB: 128,
    cpu: 'shared',
    diskMiB: 64,
    bandwidthMbps: 5,
    maxWallMs: 30_000,
    retainSeconds: 5 * 60,
    maxOutputBytes: 256 * 1024,
    price: '$0.005',
  },
  med: {
    name: 'med',
    memoryMiB: 256,
    cpu: 'full',
    diskMiB: 256,
    bandwidthMbps: 25,
    maxWallMs: 120_000,
    retainSeconds: 30 * 60,
    maxOutputBytes: 1024 * 1024,
    price: '$0.02',
  },
};

export const DEFAULT_PROFILE: ProfileName = 'small';

export function isProfileName(s: string): s is ProfileName {
  return s === 'nano' || s === 'small' || s === 'med';
}

export function getProfile(name: string): ResourceProfile {
  if (!isProfileName(name)) {
    throw new Error(`unknown profile "${name}"; expected one of: nano, small, med`);
  }
  return PROFILES[name];
}
