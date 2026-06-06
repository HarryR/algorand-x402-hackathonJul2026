/**
 * VM launcher — boots a MicroNT microVM under QEMU, places the package zips in
 * the guest pkg dir, runs `require(module)(args)`, and reads the JSON result off
 * the console.
 *
 * This is the novel, highest-risk part of the project (Milestone 0). For now it
 * is a stub that documents the intended shape; the spike fills in the QEMU spawn,
 * payload injection, and result framing.
 */

import { config } from '@/shared/config.ts';
import type { GuestInput, GuestOutput } from '@/shared/protocol.ts';
import { type ResourceProfile } from '@/shared/profiles.ts';

/** A package to drop into the guest pkg dir: filename + path to its bytes. */
export interface PackageMount {
  /** Filename as it should appear in \SystemRoot\pkg\, e.g. "blah.zip". */
  name: string;
  /** Host filesystem path to the zip bytes. */
  path: string;
}

export interface LaunchRequest {
  /** Package zips to place in the guest pkg dir before running. */
  packages: PackageMount[];
  input: GuestInput;
  profile: ResourceProfile;
}

export interface LaunchResult {
  output: GuestOutput;
  /** Wall-clock the VM was alive, ms. */
  vmWallMs: number;
}

/**
 * Launch a guest VM and return its result.
 *
 * TODO(milestone-0): spawn `config.qemuBinary` with the MicroNT PVH kernel,
 * place each `packages[].path` into the guest \SystemRoot\pkg\ as its `name`
 * (rebuilt initrd.zip or a per-call data disk), inject `input` ({require,args}),
 * apply `profile` caps (`-m`, cgroup cpu.max, disk size, bandwidth throttle),
 * then parse the framed JSON between RESULT_BEGIN/RESULT_END off the console.
 */
export async function launch(_req: LaunchRequest): Promise<LaunchResult> {
  if (!config.kernelPath) {
    throw new Error(
      'VM launcher not yet wired: set LUALAMBDA_KERNEL to a MicroNT vmlinux ' +
        '(see Milestone 0 in OUTLINE.md).',
    );
  }
  throw new Error('launch() not implemented yet — Milestone 0 spike pending.');
}
