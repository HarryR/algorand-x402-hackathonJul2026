/**
 * MBR partition-table encoder — a faithful port of nt.fs.mbr. Pure encoder, no
 * I/O: encode(layout) returns 512 bytes for sector 0 of the disk image.
 * CHS bytes are left zero (LBA-only path).
 */

export const SECTOR_SIZE = 512;
export const MAX_PARTITIONS = 4;

export interface MbrPartition {
  active?: boolean;
  typeCode?: number;
  startLba?: number;
  sectors?: number;
}

export interface MbrLayout {
  /** 32-bit disk signature at offset 0x1B8. */
  signature?: number;
  partitions?: MbrPartition[];
}

export function encode(layout: MbrLayout): Uint8Array {
  const parts = layout.partitions ?? [];
  if (parts.length > MAX_PARTITIONS) throw new Error('MBR holds at most 4 partitions');

  const sec = new Uint8Array(SECTOR_SIZE);
  const dv = new DataView(sec.buffer);
  dv.setUint32(0x1b8, (layout.signature ?? 0) >>> 0, true); // disk signature

  parts.forEach((p, i) => {
    const off = 0x1be + i * 16;
    sec[off + 0] = p.active ? 0x80 : 0x00;
    sec[off + 4] = p.typeCode ?? 0;
    dv.setUint32(off + 8, (p.startLba ?? 0) >>> 0, true);
    dv.setUint32(off + 12, (p.sectors ?? 0) >>> 0, true);
  });

  sec[0x1fe] = 0x55; // boot signature
  sec[0x1ff] = 0xaa;
  return sec;
}
