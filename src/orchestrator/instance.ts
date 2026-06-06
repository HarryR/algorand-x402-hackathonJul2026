/**
 * Per-instance disk/initrd preparation for a guest VM.
 *
 * For each invocation we materialise a throwaway instance directory holding:
 *   - initrd.zip   = a copy of the template with the user's pkg/*.zip baked in
 *                    (STORED entries; the MicroNT Lua loader reads STORED only,
 *                    and the real template is 100% STORED, so we keep it STORED).
 *                    They land under pkg/ inside the zip → at runtime the loader
 *                    sees \SystemRoot\pkg\<name>.zip and require() resolves into
 *                    them. The connect-back agent (pkg/main.lua) is ALREADY in
 *                    the template, so we do NOT inject it.
 *   - data.img     = a fresh FAT16 disk image (MBR + one FAT16 partition) sized
 *                    to the profile's diskMiB, attached as a secondary NVMe
 *                    device → \Device\Harddisk1\Partition1 in the guest.
 *                    Discarded at teardown. Built in pure TS (src/shared/fat16
 *                    + drive), so no mkfs.fat/mtools dependency — verified by a
 *                    real guest mount + write/read round-trip.
 * vmlinux is referenced read-only from the template (no per-instance copy).
 *
 * Artifacts (template initrd.zip, vmlinux) must be present; callers gate on that.
 */

import { $ } from 'bun';
import { mkdir, rm, copyFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/shared/config.ts';
import type { ResourceProfile } from '@/shared/profiles.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import { FatVolume } from '@/shared/fat16.ts';
import { Drive } from '@/shared/drive.ts';
import type { PackageMount } from './vm.ts';

/**
 * Where packages live inside the initrd zip. Entries are rooted at `pkg/`
 * (matching the template's `pkg/nt.zip`, `pkg/main.lua`); the `\SystemRoot\`
 * prefix is the runtime NT path, NOT the in-zip path.
 */
const PKG_DIR_IN_ZIP = 'pkg';

/**
 * Tracked overlay merged into a copy of the pristine upstream initrd at instance
 * prep (the upstream artifact is never modified). Files here override matching
 * template entries — e.g. overlay/pkg/main.lua replaces the upstream agent with
 * the port-from-arg fix. See src/guest/overlay/README.md.
 */
const OVERLAY_DIR = 'src/guest/overlay';

export interface PreparedInstance {
  dir: string;
  initrdPath: string;
  dataImagePath: string;
  /** Clean up the instance directory (best-effort). */
  cleanup: () => Promise<void>;
}

function assertArtifacts(): void {
  if (!config.kernelPath) {
    throw new Error('LUALAMBDA_KERNEL (vmlinux) is not set; cannot prepare an instance');
  }
  if (!config.initrdTemplatePath) {
    throw new Error('LUALAMBDA_INITRD_TEMPLATE is not set; cannot build the initrd');
  }
}

/**
 * Build the per-instance initrd: copy the PRISTINE template, then merge the
 * tracked overlay (our fixes, e.g. pkg/main.lua) and the user package zips into
 * pkg/. Uses `zip -0` (STORED) so the guest loader can read every entry —
 * including the nested package zips — and a `zip` update replaces matching
 * template entries (so the overlay overrides upstream). Re-validates that the
 * whole archive is STORED before the caller boots it.
 */
async function buildInitrd(dir: string, packages: PackageMount[]): Promise<string> {
  const initrd = join(dir, 'initrd.zip');
  await copyFile(config.initrdTemplatePath, initrd);

  // Stage overlay + package zips under a temp tree, then `zip -0 -X` them into
  // the copy. Overlay files keep their relative paths (e.g. pkg/main.lua);
  // packages drop into pkg/. The README is excluded — it's docs, not payload.
  const stage = join(dir, 'stage');
  await mkdir(join(stage, PKG_DIR_IN_ZIP), { recursive: true });
  if (existsSync(OVERLAY_DIR)) {
    await cp(OVERLAY_DIR, stage, {
      recursive: true,
      filter: (src) => !src.endsWith('README.md'),
    });
  }
  for (const p of packages) {
    await copyFile(p.path, join(stage, PKG_DIR_IN_ZIP, p.name));
  }

  // -0 STORE (loader requirement), -X drop attrs, -r recurse, -q quiet.
  await $`cd ${stage} && zip -0 -X -r -q ${initrd} .`.quiet();
  await rm(stage, { recursive: true, force: true });

  // Guard: the guest loader reads STORED entries only. If anything in the
  // rebuilt initrd is DEFLATE, fail loudly here rather than at boot.
  const check = checkStoredOnly(await Bun.file(initrd).bytes());
  if (!check.ok) {
    throw new Error(`rebuilt initrd is not STORED-only: ${check.reason}`);
  }
  return initrd;
}

/**
 * Provision a fresh FAT16 disk image of `diskMiB`: an MBR with one active FAT16
 * partition (→ \Device\Harddisk1\Partition1 in the guest). Built entirely in TS
 * (no mkfs.fat), and proven mountable by the guest's nvme2k + fastfat.
 */
async function provisionDataImage(dir: string, diskMiB: number): Promise<string> {
  const img = join(dir, 'data.img');
  const vol = FatVolume.create({ sizeMb: diskMiB, volumeLabel: 'LUALAMBDA' });
  const drive = Drive.create({ table: 'mbr', signature: 0x4c4c4144 }); // "LLAD"
  drive.add(vol, { active: true }); // default 2048-sector gap → Partition1 @ LBA 2048
  const { image } = drive.build();
  await Bun.write(img, image);
  return img;
}

/** Prepare a throwaway instance (initrd + data disk). Caller must cleanup(). */
export async function prepareInstance(
  id: string,
  packages: PackageMount[],
  profile: ResourceProfile,
): Promise<PreparedInstance> {
  assertArtifacts();
  const dir = join(config.dataDir, 'instances', id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const initrdPath = await buildInitrd(dir, packages);
  const dataImagePath = await provisionDataImage(dir, profile.diskMiB);

  return {
    dir,
    initrdPath,
    dataImagePath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
