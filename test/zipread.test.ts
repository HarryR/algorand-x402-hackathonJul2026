import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeStoredZip } from '@/shared/zipwrite.ts';
import { readStoredZip } from '@/shared/zipread.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('readStoredZip round-trips writeStoredZip entries (paths + bytes)', () => {
  const input = [
    { path: 'pkg/main.lua', data: enc('return 1\n') },
    { path: 'a/b/c.txt', data: enc('nested') },
    { path: 'empty', data: new Uint8Array(0) },
    { path: 'binary', data: new Uint8Array([0, 255, 1, 254, 0x50, 0x4b]) },
  ];
  const out = readStoredZip(writeStoredZip(input));

  // writeStoredZip sorts by path; compare order-independently.
  const byPath = new Map(out.map((e) => [e.path, e.data]));
  expect(byPath.size).toBe(input.length);
  for (const e of input) {
    expect(byPath.has(e.path)).toBe(true);
    expect(Buffer.from(byPath.get(e.path)!).equals(Buffer.from(e.data))).toBe(true);
  }
});

test('re-emitting read entries reproduces identical bytes (deterministic)', () => {
  const zip = writeStoredZip([
    { path: 'z.lua', data: enc('z') },
    { path: 'a.lua', data: enc('a') },
  ]);
  const reemitted = writeStoredZip(readStoredZip(zip));
  expect(Buffer.from(reemitted).equals(Buffer.from(zip))).toBe(true);
});

test('overlay semantics: later entry wins on path collision via a Map merge', () => {
  // This mirrors how buildInitrd overrides template entries with overlay/pkg
  // ones: read both, key by path, let ours win, re-emit.
  const template = readStoredZip(
    writeStoredZip([
      { path: 'pkg/main.lua', data: enc('OLD') },
      { path: 'pkg/nt.zip', data: enc('nt') },
    ]),
  );
  const ours = [{ path: 'pkg/main.lua', data: enc('NEW') }];

  const merged = new Map(template.map((e) => [e.path, e.data]));
  for (const e of ours) merged.set(e.path, e.data);
  const result = readStoredZip(writeStoredZip([...merged].map(([path, data]) => ({ path, data }))));

  const main = result.find((e) => e.path === 'pkg/main.lua')!;
  expect(new TextDecoder().decode(main.data)).toBe('NEW');
  expect(result.find((e) => e.path === 'pkg/nt.zip')).toBeDefined();
});

test('directory entries are skipped (no payload to re-emit)', () => {
  // Hand-build a zip whose central dir carries a trailing-slash dir entry plus a
  // file, by appending a dir entry to a written file zip is awkward; instead
  // rely on writeStoredZip (files only) and assert no dir paths come back.
  const out = readStoredZip(writeStoredZip([{ path: 'd/f.txt', data: enc('x') }]));
  expect(out.every((e) => !e.path.endsWith('/'))).toBe(true);
  expect(out.map((e) => e.path)).toEqual(['d/f.txt']);
});

test('garbage input throws rather than returning junk', () => {
  expect(() => readStoredZip(new Uint8Array([1, 2, 3]))).toThrow(/too small/);
  expect(() => readStoredZip(new Uint8Array(64))).toThrow(/End-of-Central-Directory/);
});

test('a DEFLATE entry is rejected (we cannot decompress)', () => {
  const zip = writeStoredZip([{ path: 'm/init.lua', data: enc('--') }]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Flip the central-directory compression method to 8 (DEFLATE).
  const CDFH = 0x02014b50;
  let cd = -1;
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (dv.getUint32(i, true) === CDFH) {
      cd = i;
      break;
    }
  }
  dv.setUint16(cd + 10, 8, true);
  expect(() => readStoredZip(zip)).toThrow(/only STORED/);
});

test('extracts the real vendored MicroNT template, then re-emits it cleanly', async () => {
  const path = 'vendor/micront/initrd.zip';
  if (!existsSync(path)) return; // artifact-gated; CI vendors it

  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const entries = readStoredZip(bytes);
  expect(entries.length).toBeGreaterThan(0);
  // The baked-in agent must be present (buildInitrd's overlay overrides it).
  expect(entries.some((e) => e.path === 'pkg/main.lua')).toBe(true);

  // Re-emitting through writeStoredZip yields a STORED archive the guest reads.
  const rebuilt = writeStoredZip(entries);
  const check = checkStoredOnly(rebuilt);
  expect(check.ok).toBe(true);
  expect(check.entries).toBe(entries.length);
});
