import { test, expect } from 'bun:test';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import { readStoredZip } from '@/shared/zipread.ts';
import { wrapLuaHandler, luaModulePackage } from '@/cli/zip.ts';

const dec = new TextDecoder();

test('wrapLuaHandler yields a function(args) module with the source verbatim', () => {
  const src = 'return 2 + 2';
  const wrapped = wrapLuaHandler(src);
  expect(wrapped.startsWith('return function(args)')).toBe(true);
  // Source embedded verbatim (not indented) so long [[...]] strings survive.
  expect(wrapped).toContain('\nreturn 2 + 2\n');
  // Function-detect lets full module-style chunks pass through.
  expect(wrapped).toContain('if type(r) == "function" then return r(args) end');
});

test('luaModulePackage builds a STORED <module>.zip with <module>/init.lua', () => {
  const pkg = luaModulePackage('return { ok = true }');
  expect(pkg.name).toBe('main.zip');
  expect(checkStoredOnly(pkg.bytes).ok).toBe(true);

  const entries = readStoredZip(pkg.bytes);
  expect(entries.map((e) => e.path)).toEqual(['main/init.lua']);
  expect(dec.decode(entries[0]!.data)).toBe(wrapLuaHandler('return { ok = true }'));
});

test('luaModulePackage honors a custom module name', () => {
  const pkg = luaModulePackage('return 1', 'greet');
  expect(pkg.name).toBe('greet.zip');
  expect(readStoredZip(pkg.bytes)[0]!.path).toBe('greet/init.lua');
});

test('luaModulePackage is deterministic for identical source (stable idempotency id)', () => {
  const a = luaModulePackage('return 1');
  const b = luaModulePackage('return 1');
  expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
});
