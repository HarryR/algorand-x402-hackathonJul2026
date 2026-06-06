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

/**
 * Wrap a raw Lua chunk so it satisfies the handler contract the stager expects
 * (`return function(args) ... end` — see src/orchestrator/stager.ts). The chunk
 * runs as a function body with `args` (the positional array) in scope and `...`
 * set to the unpacked args, so all of these "just work":
 *   - `return 2 + 2`                                  → 4
 *   - `return { greeting = 'hi ' .. (args[1] or '') }`→ table
 *   - a full module: `return function(a) ... end`     → called with args
 *   - bare statements (`print('hi')`)                 → null result
 * The source is embedded as a file entry (not interpolated into a Lua string), so
 * it needs no escaping and must NOT be re-indented (long `[[...]]` strings would
 * break). The function-detect lets module-style chunks pass through unchanged.
 */
export function wrapLuaHandler(source: string): string {
  return [
    'return function(args)',
    '  args = args or {}',
    '  local handler = function(...)',
    source,
    '  end',
    '  local unpack = table.unpack or unpack',
    '  local r = handler(unpack(args))',
    '  if type(r) == "function" then return r(args) end',
    '  return r',
    'end',
    '',
  ].join('\n');
}

/**
 * Build a synthetic single-module package from a raw Lua chunk: a STORED zip
 * `<module>.zip` holding `<module>/init.lua` (the wrapped source), so the guest
 * loader resolves `require('<module>')` to it. Used by `invoke` when there's no
 * `--pkg` (piped Lua) or a bare `.lua` file is given.
 */
export function luaModulePackage(source: string, moduleName = 'main'): PackageZip {
  const wrapped = wrapLuaHandler(source);
  const entries: ZipEntry[] = [
    { path: `${moduleName}/init.lua`, data: new TextEncoder().encode(wrapped) },
  ];
  return { name: `${moduleName}.zip`, bytes: writeStoredZip(entries) };
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
