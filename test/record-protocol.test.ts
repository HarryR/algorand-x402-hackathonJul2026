import { test, expect } from 'bun:test';
import {
  frameChunk,
  fileRecord,
  runRecord,
  cookedRecord,
  quitRecord,
  extractFramedResult,
  concat,
} from '@/orchestrator/record-protocol.ts';
import { RESULT_BEGIN, RESULT_END } from '@/shared/protocol.ts';

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

test('frameChunk prefixes the u32-LE source length', () => {
  const src = 'print("hi")';
  const framed = frameChunk(src);
  expect([...framed.slice(0, 4)]).toEqual(u32le(src.length));
  expect(new TextDecoder().decode(framed.slice(4))).toBe(src);
});

test('fileRecord matches agenthost.py F-record layout', () => {
  const path = '\\SystemRoot\\pkg\\hello.zip';
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const rec = fileRecord(path, data);
  const p = new TextEncoder().encode(path);
  const expected = ['F'.charCodeAt(0), ...u32le(p.length), ...p, ...u32le(data.length), ...data];
  expect([...rec]).toEqual(expected);
});

test('runRecord and cookedRecord differ only in the tag byte', () => {
  const r = runRecord('a', 'b');
  const c = cookedRecord('a', 'b');
  expect(String.fromCharCode(r[0]!)).toBe('R');
  expect(String.fromCharCode(c[0]!)).toBe('C');
  expect([...r.slice(1)]).toEqual([...c.slice(1)]);
});

test('quitRecord is a single Q byte', () => {
  expect([...quitRecord()]).toEqual(['Q'.charCodeAt(0)]);
});

test('extractFramedResult pulls the JSON between sentinels', () => {
  const json = '{"ok":true,"result":{"greeting":"hi"}}';
  const stream = new TextEncoder().encode(
    `AGENT: boot\nnoise\n${RESULT_BEGIN}\n${json}\n${RESULT_END}\ntrailing`,
  );
  expect(extractFramedResult(stream)).toBe(json);
});

test('extractFramedResult returns null for an incomplete frame', () => {
  const partial = new TextEncoder().encode(`${RESULT_BEGIN}\n{"ok":true}`);
  expect(extractFramedResult(partial)).toBeNull();
  expect(extractFramedResult(new TextEncoder().encode('no frame here'))).toBeNull();
});

test('extractFramedResult tolerates a frame split across chunks', () => {
  const json = '{"ok":false,"error":"boom"}';
  const a = new TextEncoder().encode(`${RESULT_BEGIN}\n${json.slice(0, 5)}`);
  const b = new TextEncoder().encode(`${json.slice(5)}\n${RESULT_END}\n`);
  expect(extractFramedResult(concat([a, b]))).toBe(json);
});
