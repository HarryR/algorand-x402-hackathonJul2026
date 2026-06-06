/**
 * STORED-only zip validation.
 *
 * The MicroNT guest loader reads only STORED (compression method 0) zip
 * entries, not DEFLATE. We validate uploaded packages up front so a compressed
 * zip is rejected at the API boundary with a clear message, rather than failing
 * deep inside the guest. Dependency-free; scans the End-of-Central-Directory and
 * the Central Directory file headers (the authoritative entry list).
 */

const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const CDFH_SIG = 0x02014b50; // "PK\x01\x02"
const COMPRESSION_STORED = 0;

export interface ZipCheckResult {
  ok: boolean;
  /** Reason when !ok. */
  reason?: string;
  /** Number of entries scanned (when ok). */
  entries?: number;
}

/** Find the End-of-Central-Directory record (scans backwards; no zip comment assumed). */
function findEocd(buf: DataView): number {
  // EOCD is 22 bytes minimum, at the very end absent a trailing comment.
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (buf.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Validate that every entry in the zip uses STORED compression. Returns
 * { ok: false, reason } on the first DEFLATE entry or a malformed structure.
 */
export function checkStoredOnly(bytes: Uint8Array): ZipCheckResult {
  const buf = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22) return { ok: false, reason: 'file too small to be a zip' };

  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, reason: 'no End-of-Central-Directory record (not a zip?)' };

  const total = buf.getUint16(eocd + 10, true); // total entries
  let off = buf.getUint32(eocd + 16, true); // central directory offset

  for (let i = 0; i < total; i++) {
    if (off + 46 > bytes.byteLength || buf.getUint32(off, true) !== CDFH_SIG) {
      return { ok: false, reason: `malformed central directory at entry ${i}` };
    }
    const method = buf.getUint16(off + 10, true);
    if (method !== COMPRESSION_STORED) {
      return { ok: false, reason: `entry ${i} uses compression method ${method}; only STORED (0)` };
    }
    const nameLen = buf.getUint16(off + 28, true);
    const extraLen = buf.getUint16(off + 30, true);
    const commentLen = buf.getUint16(off + 32, true);
    off += 46 + nameLen + extraLen + commentLen;
  }

  return { ok: true, entries: total };
}
