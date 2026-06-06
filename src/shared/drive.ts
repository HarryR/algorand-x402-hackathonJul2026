/**
 * Disk image composer — a faithful port of nt.fs.drive. Stitches FAT16 volume
 * builders onto a disk image with an MBR partition table and the NT ARC
 * checksum. Volume builders emit partition bytes only; this owns sector 0.
 *
 * Usage:
 *   const vol = FatVolume.create({ sizeMb: 16 });
 *   const d = Drive.create({ table: 'mbr', signature: 0x4e544653 });
 *   d.add(vol, { active: true, gapBeforeLba: 2048 });
 *   const { image, info } = d.build();   // image: Uint8Array, info: stats
 */

import { encode as mbrEncode } from './mbr.ts';
import { concatBytes, type FatVolume, type FatBuildResult } from './fat16.ts';

const SECTOR_SIZE = 512;
export const DEFAULT_GAP_LBA = 2048; // 1 MB pre-partition gap (alignment)

export interface DriveOptions {
  table?: 'mbr';
  signature?: number;
}

export interface SlotOptions {
  active?: boolean;
  gapBeforeLba?: number;
  typeCode?: number;
}

interface Slot {
  volume: FatVolume;
  active: boolean;
  gapBeforeLba?: number;
  typeCode?: number;
}

export interface DriveBuildInfo {
  sizeMb: number;
  signature: number;
  mbrChecksum: number;
  partitions: Array<{
    lba: number;
    sectors: number;
    typeCode: number;
    label: string;
    stats: FatBuildResult['stats'];
  }>;
}

export class Drive {
  private signature: number;
  private slots: Slot[] = [];

  private constructor(opts: DriveOptions) {
    const fmt = opts.table ?? 'mbr';
    if (fmt !== 'mbr') throw new Error(`nt.fs.drive: unsupported partition table '${fmt}'`);
    this.signature = (opts.signature ?? 0) >>> 0;
  }

  static create(opts: DriveOptions = {}): Drive {
    return new Drive(opts);
  }

  add(volume: FatVolume, slotOpts: SlotOptions = {}): void {
    this.slots.push({
      volume,
      active: slotOpts.active ?? false,
      gapBeforeLba: slotOpts.gapBeforeLba,
      typeCode: slotOpts.typeCode,
    });
  }

  /** Build the disk image. Returns the bytes and per-partition stats. */
  build(): { image: Uint8Array; info: DriveBuildInfo } {
    // Layout pass: assign LBAs.
    let cursorLba = 0;
    const placed = this.slots.map((slot, i) => {
      const szBytes = slot.volume.getSizeBytes();
      if (szBytes % SECTOR_SIZE !== 0) {
        throw new Error(`nt.fs.drive: slot ${i} size not sector-aligned: ${szBytes}`);
      }
      const sectors = szBytes / SECTOR_SIZE;
      const gap = slot.gapBeforeLba ?? (i === 0 ? DEFAULT_GAP_LBA : 0);
      cursorLba += gap;
      const p = {
        volume: slot.volume,
        active: slot.active,
        startLba: cursorLba,
        sectors,
        typeOverride: slot.typeCode,
      };
      cursorLba += sectors;
      return p;
    });

    const totalBytes = cursorLba * SECTOR_SIZE;
    const img = new Uint8Array(totalBytes);

    // Render each volume into its slot.
    const rendered = placed.map((p) => {
      const out = p.volume.build({ startLba: p.startLba });
      if (out.bytes.length !== p.sectors * SECTOR_SIZE) {
        throw new Error(
          `nt.fs.drive: volume bytes (${out.bytes.length}) != slot size (${p.sectors * SECTOR_SIZE})`,
        );
      }
      img.set(out.bytes, p.startLba * SECTOR_SIZE);
      return { ...p, typeCode: p.typeOverride ?? out.typeCode, label: out.label, stats: out.stats };
    });

    // Encode the partition table at sector 0.
    const tableBytes = mbrEncode({
      signature: this.signature,
      partitions: rendered.map((p) => ({
        active: p.active,
        typeCode: p.typeCode,
        startLba: p.startLba,
        sectors: p.sectors,
      })),
    });
    img.set(tableBytes, 0);

    // ARC checksum (MBR-only): two's-complement of the sum of 128 DWORDs of
    // sector 0, so (stored + sum) ≡ 0 mod 2^32.
    const sdv = new DataView(img.buffer, 0, SECTOR_SIZE);
    let sum = 0;
    for (let i = 0; i < 128; i++) sum = (sum + sdv.getUint32(i * 4, true)) >>> 0;
    const arcChecksum = -sum >>> 0;

    return {
      image: img,
      info: {
        sizeMb: Math.floor(totalBytes / (1024 * 1024)),
        signature: this.signature,
        mbrChecksum: arcChecksum,
        partitions: rendered.map((p) => ({
          lba: p.startLba,
          sectors: p.sectors,
          typeCode: p.typeCode,
          label: p.label,
          stats: p.stats,
        })),
      },
    };
  }
}

export { concatBytes };
