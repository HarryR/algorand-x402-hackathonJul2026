/**
 * Pure-TypeScript STORED zip writer. No subprocess, no native deps — works
 * identically on Linux/macOS/Windows, and survives `bun build --compile` into a
 * single self-contained binary (shelling out to a `zip` program would not).
 *
 * STORED-only (compression method 0) is exactly what the MicroNT guest loader
 * requires, and it's what makes a from-scratch writer trivial: an entry is just
 * a header + the raw bytes + a CRC32. We emit deterministic archives (entries
 * sorted by path, zeroed timestamps) so the same input yields the same bytes —
 * which keeps the content-addressed package hash stable.
 *
 * Validate output with src/shared/zipcheck.ts.
 */

export interface ZipEntry {
  /** Forward-slash path stored in the archive, e.g. "hello/init.lua". */
  path: string;
  data: Uint8Array;
}

// --- CRC32 (IEEE 802.3, the zip polynomial) ---------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- Writer -----------------------------------------------------------------

const LOCAL_SIG = 0x04034b50;
const CDFH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0 — STORED, no zip64
const STORED = 0;

/**
 * Build a deterministic STORED zip from the given entries. Entries are sorted by
 * path; timestamps are zeroed. The result is byte-stable for identical input.
 */
export function writeStoredZip(entries: ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const enc = new TextEncoder();

  interface Prepared {
    name: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }
  const prepared: Prepared[] = [];

  // First pass: local headers + data. Track each entry's local-header offset.
  const localChunks: Uint8Array[] = [];
  let offset = 0;
  for (const e of sorted) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    const header = new Uint8Array(30);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, LOCAL_SIG, true);
    dv.setUint16(4, VERSION_NEEDED, true);
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, STORED, true); // compression method
    dv.setUint16(10, 0, true); // mod time (zeroed → deterministic)
    dv.setUint16(12, 0, true); // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, e.data.length, true); // compressed size == size (STORED)
    dv.setUint32(22, e.data.length, true); // uncompressed size
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true); // extra length

    prepared.push({ name, data: e.data, crc, offset });
    localChunks.push(header, name, e.data);
    offset += header.length + name.length + e.data.length;
  }

  // Second pass: central directory.
  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const p of prepared) {
    const cd = new Uint8Array(46);
    const dv = new DataView(cd.buffer);
    dv.setUint32(0, CDFH_SIG, true);
    dv.setUint16(4, VERSION_NEEDED, true); // version made by
    dv.setUint16(6, VERSION_NEEDED, true); // version needed
    dv.setUint16(8, 0, true); // flags
    dv.setUint16(10, STORED, true);
    dv.setUint16(12, 0, true); // mod time
    dv.setUint16(14, 0, true); // mod date
    dv.setUint32(16, p.crc, true);
    dv.setUint32(20, p.data.length, true); // compressed size
    dv.setUint32(24, p.data.length, true); // uncompressed size
    dv.setUint16(28, p.name.length, true);
    dv.setUint16(30, 0, true); // extra length
    dv.setUint16(32, 0, true); // comment length
    dv.setUint16(34, 0, true); // disk number start
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, p.offset, true); // local header offset

    centralChunks.push(cd, p.name);
    centralSize += cd.length + p.name.length;
  }

  // End of central directory.
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, EOCD_SIG, true);
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk with central dir
  edv.setUint16(8, prepared.length, true); // entries on this disk
  edv.setUint16(10, prepared.length, true); // total entries
  edv.setUint32(12, centralSize, true); // central dir size
  edv.setUint32(16, offset, true); // central dir offset
  edv.setUint16(20, 0, true); // comment length

  // Concatenate everything.
  const all = [...localChunks, ...centralChunks, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
