/**
 * Pure-TypeScript STORED zip reader — the inverse of src/shared/zipwrite.ts.
 *
 * No subprocess, no native deps (no `unzip`, no inflate), so it works the same
 * on Linux/macOS/Windows and survives `bun build --compile` into one binary —
 * which is the whole reason the rest of the project never shells out to `zip`.
 *
 * STORED-only (compression method 0): a STORED entry's bytes sit raw on disk, so
 * extraction is just "read length bytes at the local-header data offset" — no
 * decompression. The central directory (walked the same way as
 * src/shared/zipcheck.ts) is the authoritative entry list; we resolve each
 * entry's local header to find where its data begins.
 *
 * Pair with writeStoredZip to read → merge → re-emit an archive in-process.
 */

import type { ZipEntry } from './zipwrite.ts';

const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const CDFH_SIG = 0x02014b50; // "PK\x01\x02"
const LOCAL_SIG = 0x04034b50; // "PK\x03\x04"
const COMPRESSION_STORED = 0;

/** Find the End-of-Central-Directory record (scans backwards; no zip comment assumed). */
function findEocd(buf: DataView): number {
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (buf.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Extract every STORED entry as { path, data }. Throws on a malformed structure
 * or any non-STORED (e.g. DEFLATE) entry — we can't decompress, and the guest
 * loader couldn't read it anyway. Directory entries (paths ending in `/`) are
 * skipped; writeStoredZip stores only files, so re-emitting drops them harmlessly.
 */
export function readStoredZip(bytes: Uint8Array): ZipEntry[] {
  const buf = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22) throw new Error('file too small to be a zip');

  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('no End-of-Central-Directory record (not a zip?)');

  const total = buf.getUint16(eocd + 10, true); // total entries
  let off = buf.getUint32(eocd + 16, true); // central directory offset
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];

  for (let i = 0; i < total; i++) {
    if (off + 46 > bytes.byteLength || buf.getUint32(off, true) !== CDFH_SIG) {
      throw new Error(`malformed central directory at entry ${i}`);
    }
    const method = buf.getUint16(off + 10, true);
    const compSize = buf.getUint32(off + 20, true);
    const nameLen = buf.getUint16(off + 28, true);
    const extraLen = buf.getUint16(off + 30, true);
    const commentLen = buf.getUint16(off + 32, true);
    const localOff = buf.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));

    if (method !== COMPRESSION_STORED) {
      throw new Error(`entry ${i} ("${name}") uses compression method ${method}; only STORED (0)`);
    }

    // Resolve the local header: its name/extra lengths may differ from the
    // central record's, so read them from the local header itself.
    if (localOff + 30 > bytes.byteLength || buf.getUint32(localOff, true) !== LOCAL_SIG) {
      throw new Error(`entry ${i} ("${name}") has a malformed local header`);
    }
    const lNameLen = buf.getUint16(localOff + 26, true);
    const lExtraLen = buf.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > bytes.byteLength) {
      throw new Error(`entry ${i} ("${name}") data runs past end of file`);
    }

    // Skip directory entries; only files carry payload we re-emit.
    if (!name.endsWith('/')) {
      // Copy out so the slice is independent of the source buffer's lifetime.
      entries.push({ path: name, data: bytes.slice(dataStart, dataStart + compSize) });
    }

    off += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
