/**
 * Host side of the MicroNT connect-back record protocol.
 *
 * Mirrors tmp/agenthost.py. The guest agent (guest main.lua) dials back to the
 * host and reads ONE length-prefixed Lua "stager" chunk (u32-LE length + that
 * many bytes of source). The stager then reads a stream of records:
 *
 *   'F' <u32 pathlen><path utf8> <u32 datalen><data>   write a file (mkdir -p)
 *   'R' <u32 exelen><exe utf8>   <u32 cmdlen><cmdline>  spawn + wait (raw stdio)
 *   'C' <u32 exelen><exe utf8>   <u32 cmdlen><cmdline>  spawn + wait (cooked tty)
 *   'Q'                                                  done
 *
 * All integers are u32 little-endian. We bake the user's packages into the
 * initrd, so the normal lualambda path needs no 'F' records — just run the Lua
 * module and read its framed JSON result back. The 'F' builder is kept for
 * parity with the reference (late-bound/oversized packages).
 *
 * Pure and dependency-free → unit-tested without QEMU.
 */

import { RESULT_BEGIN, RESULT_END } from '@/shared/protocol.ts';

// --- Low-level encoders -----------------------------------------------------

function u32le(n: number): Uint8Array {
  if (n < 0 || n > 0xffffffff || !Number.isInteger(n)) {
    throw new RangeError(`u32 out of range: ${n}`);
  }
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** Read a little-endian u32 at `offset` (caller ensures `offset + 4 <= length`). */
export function readU32LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, true);
}

/** Length-prefixed byte string: <u32 len><bytes>. */
function lstr(bytes: Uint8Array): Uint8Array {
  return concat([u32le(bytes.length), bytes]);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// --- Record builders --------------------------------------------------------

/** The initial framed chunk the agent expects: <u32 len><lua source>. */
export function frameChunk(luaSource: string): Uint8Array {
  const src = utf8(luaSource);
  return concat([u32le(src.length), src]);
}

/** 'F' write-file record (NT path + data). */
export function fileRecord(ntPath: string, data: Uint8Array): Uint8Array {
  return concat([utf8('F'), lstr(utf8(ntPath)), lstr(data)]);
}

/** 'R' spawn+wait record (raw stdio). */
export function runRecord(exe: string, cmdline: string): Uint8Array {
  return concat([utf8('R'), lstr(utf8(exe)), lstr(utf8(cmdline))]);
}

/** 'C' spawn+wait record (cooked tty line discipline). */
export function cookedRecord(exe: string, cmdline: string): Uint8Array {
  return concat([utf8('C'), lstr(utf8(exe)), lstr(utf8(cmdline))]);
}

/** 'Q' quit record. */
export function quitRecord(): Uint8Array {
  return utf8('Q');
}

// --- Result framing ---------------------------------------------------------

/**
 * Extract the JSON payload the guest emits between the RESULT_BEGIN/RESULT_END
 * sentinels (emitted by the stager, src/orchestrator/stager.ts). Returns the raw
 * JSON string, or null if the frame is absent/incomplete. We scan a byte buffer
 * decoded as UTF-8 since the stager writes the frame as text on the socket.
 */
export function extractFramedResult(buf: Uint8Array): string | null {
  const text = new TextDecoder().decode(buf);
  const begin = text.indexOf(RESULT_BEGIN);
  if (begin < 0) return null;
  const after = begin + RESULT_BEGIN.length;
  const end = text.indexOf(RESULT_END, after);
  if (end < 0) return null;
  return text.slice(after, end).trim();
}
