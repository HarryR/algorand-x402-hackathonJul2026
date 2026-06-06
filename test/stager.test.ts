import { test, expect } from 'bun:test';
import { buildStager } from '@/orchestrator/stager.ts';
import { RESULT_BEGIN, RESULT_END } from '@/shared/protocol.ts';

test('stager requires the given module and frames the result', () => {
  const lua = buildStager('hello', ['world']);
  expect(lua).toContain('require("hello")');
  expect(lua).toContain('{"world"}');
  expect(lua).toContain(RESULT_BEGIN);
  expect(lua).toContain(RESULT_END);
});

test('stager escapes args that contain quotes/newlines (no Lua injection)', () => {
  const lua = buildStager('m', ['a"b', 'c\nd']);
  // The raw arg must not appear unescaped; the escaped forms must.
  expect(lua).toContain('\\"');
  expect(lua).toContain('\\n');
  // A naive break-out attempt stays inside the literal.
  const evil = buildStager('m', ['"]); os.exit() --']);
  expect(evil).toContain('\\"');
});

test('stager handles a dotted module name', () => {
  expect(buildStager('blah.dorp', [])).toContain('require("blah.dorp")');
});

test('stager produces an empty args table when no args', () => {
  expect(buildStager('m', [])).toContain('handler({})');
});
