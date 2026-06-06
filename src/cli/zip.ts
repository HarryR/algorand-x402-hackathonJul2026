/**
 * Resolve a `--pkg` argument into uploadable package bytes.
 *
 * A `--pkg` may be either:
 *   - an existing `.zip` file → uploaded VERBATIM (we only verify it's STORED);
 *   - a directory → zipped IN-PROCESS into a deterministic STORED zip whose
 *     entries are prefixed by the dir's basename, so `hello/` → `hello.zip`
 *     containing `hello/init.lua` and require('hello') resolves correctly.
 *
 * Zipping is pure TypeScript (src/shared/zipwrite.ts) — no `zip` subprocess — so
 * it works on Windows and survives `bun build --compile` into one binary.
 */

import { stat, readdir, readFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { writeStoredZip, type ZipEntry } from '@/shared/zipwrite.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';

const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

export interface PackageZip {
  /** Suggested filename, e.g. "hello.zip". */
  name: string;
  bytes: Uint8Array;
}

/** Recursively collect files under `dir`, returning archive paths + bytes. */
async function collect(dir: string, prefix: string): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const ents = await readdir(dir, { withFileTypes: true });
  for (const ent of ents) {
    if (SKIP_NAMES.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    // Always use forward slashes in archive paths (zip convention).
    const archPath = `${prefix}/${ent.name}`;
    if (ent.isDirectory()) {
      out.push(...(await collect(abs, archPath)));
    } else if (ent.isFile()) {
      out.push({ path: archPath, data: new Uint8Array(await readFile(abs)) });
    }
  }
  return out;
}

/** Build a deterministic STORED zip of a package directory (in-process). */
export async function zipPackage(dir: string): Promise<PackageZip> {
  const base = basename(dir.replace(new RegExp(`${sep}+$`), '')); // tolerate trailing slash
  const entries = await collect(dir, base);
  if (entries.length === 0) throw new Error(`package dir "${dir}" is empty`);
  return { name: `${base}.zip`, bytes: writeStoredZip(entries) };
}

/**
 * Resolve a `--pkg` path: pass through an existing `.zip` (verbatim, STORED-
 * checked) or zip a directory in-process.
 */
export async function resolvePackage(path: string): Promise<PackageZip> {
  const info = await stat(path).catch(() => {
    throw new Error(`--pkg path not found: ${path}`);
  });

  if (info.isFile()) {
    if (!path.toLowerCase().endsWith('.zip')) {
      throw new Error(`--pkg file must be a .zip (or pass a directory): ${path}`);
    }
    const bytes = new Uint8Array(await readFile(path));
    const check = checkStoredOnly(bytes);
    if (!check.ok) {
      throw new Error(`${path} is not a STORED zip the guest can read: ${check.reason}`);
    }
    return { name: basename(path), bytes };
  }

  if (info.isDirectory()) return zipPackage(path);

  throw new Error(`--pkg must be a .zip file or a directory: ${path}`);
}
