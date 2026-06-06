/**
 * Per-instance disk/initrd preparation for a guest VM.
 *
 * For each invocation we materialise a throwaway instance directory holding:
 *   - initrd.zip   = the template merged with our overlay + the user's pkg/*.zip
 *                    (STORED entries; the MicroNT Lua loader reads STORED only,
 *                    and the real template is 100% STORED, so we keep it STORED).
 *                    They land under pkg/ inside the zip → at runtime the loader
 *                    sees \SystemRoot\pkg\<name>.zip and require() resolves into
 *                    them. The connect-back agent (pkg/main.lua) ships in the
 *                    template; our overlay overrides it with the port-from-arg fix.
 *   - data.img     = a fresh FAT16 disk image (MBR + one FAT16 partition) sized
 *                    to the profile's diskMiB, attached as a secondary NVMe
 *                    device → \Device\Harddisk1\Partition1 in the guest.
 *                    Discarded at teardown. Built in pure TS (src/shared/fat16
 *                    + drive), so no mkfs.fat/mtools dependency — verified by a
 *                    real guest mount + write/read round-trip.
 *
 * The template, overlay, and vmlinux are embedded in the binary (see
 * ./artifacts.ts); vmlinux is materialized to a real path for QEMU in vm.ts.
 */

import { mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { config } from '@/shared/config.ts';
import type { ResourceProfile } from '@/shared/profiles.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import { readStoredZip } from '@/shared/zipread.ts';
import { writeStoredZip } from '@/shared/zipwrite.ts';
import { FatVolume } from '@/shared/fat16.ts';
import { Drive } from '@/shared/drive.ts';
import { initrdTemplateBytes, initrdTemplatePath, overlayEntries } from './artifacts.ts';
import type { PackageMount } from './vm.ts';

/**
 * Where packages live inside the initrd zip. Entries are rooted at `pkg/`
 * (matching the template's `pkg/nt.zip`, `pkg/main.lua`); the `\SystemRoot\`
 * prefix is the runtime NT path, NOT the in-zip path.
 */
const PKG_DIR_IN_ZIP = 'pkg';

export interface PreparedInstance {
  dir: string;
  initrdPath: string;
  dataImagePath: string;
  /** Clean up the instance directory (best-effort). */
  cleanup: () => Promise<void>;
}

function assertArtifacts(): void {
  // Kernel + initrd default to embedded artifacts (see ./artifacts.ts), so these
  // resolve unless an env override is explicitly blanked. The initrd template is
  // what prepareInstance needs; the kernel is materialized later, in launch().
  if (!initrdTemplatePath()) {
    throw new Error('initrd template path is empty; cannot build the initrd');
  }
}

/**
 * Build the per-instance initrd entirely in-process — no `zip` subprocess, so it
 * works in a `bun build --compile` binary and on Windows (matching the rest of
 * the project; see src/shared/zipwrite.ts). Read the PRISTINE template's STORED
 * entries, then merge in the tracked overlay (our fixes, e.g. pkg/main.lua) and
 * the user package zips under pkg/, with ours overriding matching template
 * entries on path collision. Re-emit as a STORED archive the guest loader reads.
 */
async function buildInitrd(dir: string, packages: PackageMount[]): Promise<string> {
  const templateBytes = await initrdTemplateBytes();

  // Key by archive path so overlay/package entries override the template.
  const merged = new Map<string, Uint8Array>();
  for (const e of readStoredZip(templateBytes)) merged.set(e.path, e.data);
  for (const e of await overlayEntries()) merged.set(e.path, e.data);
  for (const p of packages) {
    const path = `${PKG_DIR_IN_ZIP}/${p.name}`;
    merged.set(path, new Uint8Array(await readFile(p.path)));
  }

  const bytes = writeStoredZip([...merged].map(([path, data]) => ({ path, data })));

  // Guard: writeStoredZip is STORED by construction, but assert before boot so a
  // future change can't silently produce an archive the guest loader can't read.
  const check = checkStoredOnly(bytes);
  if (!check.ok) {
    throw new Error(`rebuilt initrd is not STORED-only: ${check.reason}`);
  }

  const initrd = join(dir, 'initrd.zip');
  await Bun.write(initrd, bytes);
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
  // Defense-in-depth: `id` is validated at the API boundary
  // (src/shared/validate.ts), but this dir feeds a recursive delete — assert it
  // resolves to a direct child of the instances root so a missed/changed caller
  // can't escape it via traversal. Reject, don't normalize.
  const root = resolve(config.dataDir, 'instances');
  const dir = resolve(join(root, id));
  // Instance dirs are flat, one per id: the resolved path must be a DIRECT child
  // of the instances root. This rejects traversal (`../x`), absolute paths, and
  // nested ids (`a/b`) that a missed boundary check might let through.
  if (dirname(dir) !== root) {
    throw new Error(`refusing to prepare instance outside ${root}: ${id}`);
  }
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
