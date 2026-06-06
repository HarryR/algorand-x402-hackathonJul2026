import { test, expect, afterEach } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  initrdTemplatePath,
  initrdTemplateBytes,
  overlayEntries,
  kernelPath,
} from '@/orchestrator/artifacts.ts';

// These run in dev mode (`bun test`), where the embed imports resolve to the real
// on-disk vendor/src paths. The compiled-binary path (bytes baked into $bunfs) is
// covered by the self-contained binary verification, not unit tests.

const ENV = { ...process.env };
afterEach(() => {
  process.env.LUALAMBDA_INITRD_TEMPLATE = ENV.LUALAMBDA_INITRD_TEMPLATE;
});

test('initrdTemplatePath defaults to the embedded/vendored initrd', () => {
  delete process.env.LUALAMBDA_INITRD_TEMPLATE;
  // Dev: resolves to the real vendor path; just assert it's a non-empty .zip path.
  expect(initrdTemplatePath()).toMatch(/initrd\.zip$/);
});

test('initrdTemplatePath honors LUALAMBDA_INITRD_TEMPLATE override', () => {
  process.env.LUALAMBDA_INITRD_TEMPLATE = '/custom/base.zip';
  expect(initrdTemplatePath()).toBe('/custom/base.zip');
});

test('initrdTemplateBytes returns the real template (STORED, non-trivial size)', async () => {
  delete process.env.LUALAMBDA_INITRD_TEMPLATE;
  const bytes = await initrdTemplateBytes();
  expect(bytes.byteLength).toBeGreaterThan(1_000_000); // ~4.3 MB template
  // PK signature — it's a zip.
  expect(bytes[0]).toBe(0x50);
  expect(bytes[1]).toBe(0x4b);
});

test('overlayEntries yields exactly pkg/main.lua matching the source file', async () => {
  const entries = await overlayEntries();
  expect(entries.map((e) => e.path)).toEqual(['pkg/main.lua']);
  const source = new Uint8Array(await readFile('src/guest/overlay/pkg/main.lua'));
  expect(Buffer.from(entries[0]!.data).equals(Buffer.from(source))).toBe(true);
});

test('kernelPath materializes a real, readable on-disk file', async () => {
  // No LUALAMBDA_KERNEL override in the test env → extracts the embedded vmlinux
  // into config.workDir/runtime. kernelPath() memoizes, so this is the one call.
  const p = await kernelPath();
  expect(existsSync(p)).toBe(true);
  expect(p).toMatch(/runtime[/\\]vmlinux$/);
  const bytes = new Uint8Array(await readFile(p));
  expect(bytes.byteLength).toBeGreaterThan(0);
  // ELF magic — vmlinux is a PVH loader ELF.
  expect(Array.from(bytes.slice(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46]);
});
