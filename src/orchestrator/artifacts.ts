/**
 * MicroNT runtime artifacts, embedded into the compiled binary.
 *
 * The orchestrator needs three things at runtime that won't exist on a bare
 * deployment host: the kernel (vmlinux), the initrd template, and the guest
 * overlay (pkg/main.lua). We embed all three with Bun's `with { type: 'file' }`
 * import attribute so `bun build --compile` bakes their bytes into the single
 * binary — shipping MicroNT alongside the orchestrator.
 *
 * In dev (`bun run`) these same imports resolve to the REAL on-disk vendor/src
 * paths, so one code path serves both modes. `LUALAMBDA_*` env vars still
 * override (prod can point at a different kernel/initrd).
 *
 * Embedded files surface as a `$bunfs/...` virtual path. That reads fine via
 * `Bun.file()`/Node fs (in-process: initrd template + overlay), but a FOREIGN
 * subprocess can't open() it — so the kernel, which is handed to the
 * qemu-system-x86_64 subprocess as `-kernel <path>`, must be materialized to a
 * real on-disk file first (see kernelPath). cf. Bun PR #30720, which extracts
 * embedded shared libs from bunfs before dlopen().
 */

import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/shared/config.ts';
import type { ZipEntry } from '@/shared/zipwrite.ts';

// Embedded artifact paths. Resolve to real vendor/src paths under `bun run`, and
// to baked-in `$bunfs/...` paths in a compiled binary. Each import yields a path
// string at runtime; TypeScript can't type a real binary asset under
// `moduleResolution: bundler` (it resolves the file on disk but has no module
// type for it), so the per-import suppressions below are expected and required.
// @ts-expect-error embedded-file import (Bun `with { type: 'file' }`) → string
import KERNEL_FILE from '../../vendor/micront/vmlinux' with { type: 'file' };
// @ts-expect-error embedded-file import (Bun `with { type: 'file' }`) → string
import INITRD_TEMPLATE_FILE from '../../vendor/micront/initrd.zip' with { type: 'file' };
// @ts-expect-error embedded-file import (Bun `with { type: 'file' }`) → string
import OVERLAY_MAIN_LUA from '../guest/overlay/pkg/main.lua' with { type: 'file' };

/** Archive path of the overlay agent inside the initrd (see instance.ts). */
const OVERLAY_AGENT_PATH = 'pkg/main.lua';

/**
 * Path to the initrd template to merge per instance. `LUALAMBDA_INITRD_TEMPLATE`
 * overrides the embedded default (prod can ship a different base system).
 */
export function initrdTemplatePath(): string {
  return process.env.LUALAMBDA_INITRD_TEMPLATE || INITRD_TEMPLATE_FILE;
}

/** Bytes of the initrd template (read in-process; embedded path is fine here). */
export async function initrdTemplateBytes(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(initrdTemplatePath()).bytes());
}

/**
 * The tracked overlay merged over the template — our fixes that override
 * upstream entries on path collision. Currently a single file
 * (src/guest/overlay/pkg/main.lua → pkg/main.lua); add more embed imports here if
 * the overlay grows. The README is docs, not payload, so it's never included.
 */
export async function overlayEntries(): Promise<ZipEntry[]> {
  const data = new Uint8Array(await Bun.file(OVERLAY_MAIN_LUA).bytes());
  return [{ path: OVERLAY_AGENT_PATH, data }];
}

// --- Kernel: materialize the embedded vmlinux to a real on-disk path ---------

let kernelPromise: Promise<string> | undefined;

async function materializeKernel(): Promise<string> {
  // Prod override is already a real path — use it directly, no extraction.
  const override = process.env.LUALAMBDA_KERNEL;
  if (override) return override;

  const bytes = await Bun.file(KERNEL_FILE).bytes();
  const dir = join(config.dataDir, 'runtime');
  await mkdir(dir, { recursive: true });

  // Atomic publish: write to a temp name, then rename into place, so a racing
  // process never observes a half-written kernel. The final name is stable, so
  // repeated runs (and fresh processes) reuse it.
  const dst = join(dir, 'vmlinux');
  const tmp = `${dst}.tmp`;
  await Bun.write(tmp, bytes);
  await rename(tmp, dst);
  return dst;
}

/**
 * Real on-disk path to the kernel, suitable for the QEMU `-kernel` arg.
 * Memoized: the embedded bytes are extracted once per process and reused across
 * every VM launch. Honors `LUALAMBDA_KERNEL` (returned verbatim, no extraction).
 */
export function kernelPath(): Promise<string> {
  return (kernelPromise ??= materializeKernel());
}
