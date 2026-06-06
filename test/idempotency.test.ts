import { test, expect } from 'bun:test';
import { deriveId } from '@/shared/idempotency.ts';

const pkgA = new Uint8Array([1, 2, 3, 4]);
const pkgB = new Uint8Array([5, 6, 7, 8]);

test('same inputs derive the same id', async () => {
  const a = await deriveId([pkgA], 'hello', ['world']);
  const b = await deriveId([pkgA], 'hello', ['world']);
  expect(a).toBe(b);
});

test('package order does not change the id (hashes are sorted)', async () => {
  const a = await deriveId([pkgA, pkgB], 'hello', []);
  const b = await deriveId([pkgB, pkgA], 'hello', []);
  expect(a).toBe(b);
});

test('different module or args change the id', async () => {
  const base = await deriveId([pkgA], 'hello', ['world']);
  expect(await deriveId([pkgA], 'other', ['world'])).not.toBe(base);
  expect(await deriveId([pkgA], 'hello', ['mars'])).not.toBe(base);
});

test('arg order matters', async () => {
  const ab = await deriveId([pkgA], 'm', ['a', 'b']);
  const ba = await deriveId([pkgA], 'm', ['b', 'a']);
  expect(ab).not.toBe(ba);
});
