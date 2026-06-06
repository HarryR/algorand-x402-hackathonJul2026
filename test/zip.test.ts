import { test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStoredZip } from '@/shared/zipwrite.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import { zipPackage, resolvePackage } from '@/cli/zip.ts';

test('zipPackage produces a STORED zip named after the dir, prefixed paths', async () => {
  const { name, bytes } = await zipPackage('examples/hello');
  expect(name).toBe('hello.zip');
  expect(checkStoredOnly(bytes).ok).toBe(true);
  // The dir-prefixed path must appear literally (require('hello') resolution).
  expect(Buffer.from(bytes).includes(Buffer.from('hello/init.lua'))).toBe(true);
});

test('zipPackage is deterministic across runs', async () => {
  const a = await zipPackage('examples/hello');
  const b = await zipPackage('examples/hello');
  expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
});

test('writeStoredZip output validates and round-trips its bytes', () => {
  const data = new TextEncoder().encode('return function() return 1 end\n');
  const zip = writeStoredZip([{ path: 'm/init.lua', data }]);
  const check = checkStoredOnly(zip);
  expect(check.ok).toBe(true);
  expect(check.entries).toBe(1);
  // The stored bytes appear verbatim (STORED = no compression).
  expect(Buffer.from(zip).includes(Buffer.from(data))).toBe(true);
});

test('writeStoredZip sorts entries deterministically regardless of input order', () => {
  const a = writeStoredZip([
    { path: 'b.lua', data: new Uint8Array([1]) },
    { path: 'a.lua', data: new Uint8Array([2]) },
  ]);
  const b = writeStoredZip([
    { path: 'a.lua', data: new Uint8Array([2]) },
    { path: 'b.lua', data: new Uint8Array([1]) },
  ]);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
});

test('resolvePackage: a directory is zipped in-process', async () => {
  const p = await resolvePackage('examples/hello');
  expect(p.name).toBe('hello.zip');
  expect(checkStoredOnly(p.bytes).ok).toBe(true);
});

test('resolvePackage: an existing STORED .zip is passed through verbatim', async () => {
  const built = await zipPackage('examples/hello');
  const path = join(tmpdir(), `lualambda-test-${crypto.randomUUID()}.zip`);
  await Bun.write(path, built.bytes);

  const resolved = await resolvePackage(path);
  expect(Buffer.from(resolved.bytes).equals(Buffer.from(built.bytes))).toBe(true);

  await Bun.file(path).delete();
});

test('resolvePackage: a non-zip file is rejected', async () => {
  const path = join(tmpdir(), `lualambda-test-${crypto.randomUUID()}.txt`);
  await Bun.write(path, 'not a zip');
  await expect(resolvePackage(path)).rejects.toThrow(/must be a \.zip/);
  await Bun.file(path).delete();
});

test('resolvePackage: a missing path is rejected', async () => {
  await expect(resolvePackage('/no/such/path-xyz')).rejects.toThrow(/not found/);
});
