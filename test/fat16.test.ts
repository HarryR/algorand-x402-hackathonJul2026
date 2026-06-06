import { test, expect } from 'bun:test';
import { FatVolume, PARTITION_TYPE_FAT16 } from '@/shared/fat16.ts';
import { encode as mbrEncode } from '@/shared/mbr.ts';
import { Drive } from '@/shared/drive.ts';

const NOW = 1_700_000_000;

test('FatVolume emits a spec-correct FAT16 boot sector', () => {
  const out = FatVolume.create({ sizeMb: 16, volumeLabel: 'LUALAMBDA', now: NOW }).build();
  expect(out.bytes.length).toBe(16 * 1024 * 1024);
  expect(out.typeCode).toBe(PARTITION_TYPE_FAT16);

  const dv = new DataView(out.bytes.buffer);
  expect(dv.getUint16(0x0b, true)).toBe(512); // bytes/sector
  expect(out.bytes[0x0d]).toBe(4); // sectors/cluster (<=128 MB)
  expect(dv.getUint16(0x0e, true)).toBe(1); // reserved
  expect(out.bytes[0x10]).toBe(2); // num FATs
  expect(dv.getUint16(0x11, true)).toBe(512); // root entries
  expect(out.bytes[0x15]).toBe(0xf8); // media descriptor
  expect(out.bytes[0x1fe]).toBe(0x55); // boot signature
  expect(out.bytes[0x1ff]).toBe(0xaa);
  expect(new TextDecoder().decode(out.bytes.slice(0x36, 0x3e))).toBe('FAT16   ');

  // FAT[0]/FAT[1] reserved markers.
  const fat1 = 1 * 512;
  expect(dv.getUint16(fat1, true)).toBe(0xfff8);
  expect(dv.getUint16(fat1 + 2, true)).toBe(0xffff);
});

test('HiddenSectors (BPB) reflects the partition start LBA', () => {
  const out = FatVolume.create({ sizeMb: 16, now: NOW }).build({ startLba: 2048 });
  expect(new DataView(out.bytes.buffer).getUint32(0x1c, true)).toBe(2048);
});

test('a short name lands as a single 8.3 dirent in the root', () => {
  const vol = FatVolume.create({ sizeMb: 16, now: NOW });
  vol.addBytes('HELLO.TXT', new TextEncoder().encode('hi'));
  const out = vol.build();
  // 8.3 entry name appears space-padded in the root region.
  expect(Buffer.from(out.bytes).includes(Buffer.from('HELLO   TXT'))).toBe(true);
});

test('a long name produces a VFAT LFN chain plus an 8.3 alias', () => {
  const vol = FatVolume.create({ sizeMb: 16, now: NOW });
  vol.addBytes('a-long-file-name.lua', new TextEncoder().encode('x'));
  const out = vol.build();
  // Alias stem "ALONGF~1" (non-alnum stripped, ~1 suffix), ext "LUA".
  expect(Buffer.from(out.bytes).includes(Buffer.from('ALONGF~1LUA'))).toBe(true);
});

test('the build is deterministic for identical input', () => {
  const mk = () => {
    const v = FatVolume.create({ sizeMb: 16, volumeLabel: 'NT', now: NOW });
    v.addBytes('a.txt', new TextEncoder().encode('hello'));
    v.mkdir('sub');
    v.addBytes('sub/b.txt', new TextEncoder().encode('world'));
    return v.build({ startLba: 2048 }).bytes;
  };
  expect(Buffer.from(mk()).equals(Buffer.from(mk()))).toBe(true);
});

test('MBR encoder lays out signature, one active FAT16 partition, boot sig', () => {
  const sec = mbrEncode({
    signature: 0x4c4c4144,
    partitions: [{ active: true, typeCode: 0x06, startLba: 2048, sectors: 32768 }],
  });
  expect(sec.length).toBe(512);
  const dv = new DataView(sec.buffer);
  expect(dv.getUint32(0x1b8, true)).toBe(0x4c4c4144);
  expect(sec[0x1be]).toBe(0x80); // active
  expect(sec[0x1be + 4]).toBe(0x06); // type FAT16
  expect(dv.getUint32(0x1be + 8, true)).toBe(2048); // start LBA
  expect(dv.getUint32(0x1be + 12, true)).toBe(32768); // sectors
  expect(sec[0x1fe]).toBe(0x55);
  expect(sec[0x1ff]).toBe(0xaa);
});

test('MBR rejects more than four partitions', () => {
  expect(() => mbrEncode({ partitions: new Array(5).fill({}) })).toThrow(/at most 4/);
});

test('Drive composes a disk with a gap, MBR, and a zeroing ARC checksum', () => {
  const vol = FatVolume.create({ sizeMb: 16, now: NOW });
  const drive = Drive.create({ table: 'mbr', signature: 0x4c4c4144 });
  drive.add(vol, { active: true });
  const { image, info } = drive.build();

  // 2048-sector gap + 16 MiB volume.
  expect(image.length).toBe((2048 + (16 * 1024 * 1024) / 512) * 512);
  expect(info.partitions[0]!.lba).toBe(2048);
  expect(info.partitions[0]!.typeCode).toBe(PARTITION_TYPE_FAT16);

  // The FAT16 boot sector sits at the partition start, not sector 0.
  expect(image[0x1fe]).toBe(0x55); // MBR boot sig
  expect(image[2048 * 512 + 0x1fe]).toBe(0x55); // VBR boot sig

  // ARC checksum: stored + sum of 128 DWORDs of sector 0 ≡ 0 (mod 2^32).
  const dv = new DataView(image.buffer, 0, 512);
  let sum = 0;
  for (let i = 0; i < 128; i++) sum = (sum + dv.getUint32(i * 4, true)) >>> 0;
  expect((sum + info.mbrChecksum) >>> 0).toBe(0);
});
