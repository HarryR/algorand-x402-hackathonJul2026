/**
 * FAT16 volume builder — a faithful TypeScript port of nt.fs.fat16 (the Lua
 * builder ntosbe drives via nt.zip). Produces partition payload bytes only (no
 * MBR, no disk stitching); src/shared/drive.ts composes the disk image around it.
 *
 * Same on-disk format as the Lua original (FAT16 type 0x06, NT 3.5 atdisk +
 * fastfat compatible), including 8.3 short names and VFAT long-name (LFN) chains.
 * Porting it to pure TS drops the mkfs.fat/mtools dependency entirely, so the
 * orchestrator can provision the per-instance NVMe data disk with no native tool.
 *
 * Usage:
 *   const vol = FatVolume.create({ sizeMb: 16, volumeLabel: 'NT' });
 *   vol.addBytes('hello.txt', new TextEncoder().encode('hi'));
 *   vol.mkdir('tmp');
 *   const out = vol.build({ startLba: 2048 });  // → { bytes, typeCode, ... }
 */

const SECTOR_SIZE = 512;
const RESERVED_SECTORS = 1;
const NUM_FATS = 2;
const ROOT_DIR_ENTRIES = 512; // FAT16 convention — fixed root
const ROOT_DIR_SECTORS = (ROOT_DIR_ENTRIES * 32) / SECTOR_SIZE; // 32

export const PARTITION_TYPE_FAT16 = 0x06; // FAT16 >= 32 MB

const CLUSTER_EOC = 0xffff;
const ATTR_VOLUME_ID = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;

/** FAT16 cluster size scaling (sectors-per-cluster) by volume size. */
function defaultSpc(sizeMb: number): number {
  if (sizeMb <= 128) return 4; // 2 KB clusters
  if (sizeMb <= 256) return 8; // 4 KB
  if (sizeMb <= 512) return 16; // 8 KB
  if (sizeMb <= 1024) return 32; // 16 KB
  return 64; // 32 KB (max FAT16: 2 GB)
}

// --- 8.3 + VFAT LFN name encoding -------------------------------------------

const enc = new TextEncoder();

function pad83(s: string, n: number): string {
  return s + ' '.repeat(n - s.length);
}

/** Strict 8.3 short name (11 bytes, space-padded, uppercased), or null. */
function try83(name: string): string | null {
  name = name.toUpperCase();
  const dotIdx = name.lastIndexOf('.');
  const stem = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
  const ext = dotIdx >= 0 ? name.slice(dotIdx + 1) : '';
  if (stem.length === 0 || stem.length > 8 || ext.length > 3) return null;
  // 8.3 forbids dots in the stem (a second dot makes it non-8.3).
  if (stem.includes('.')) return null;
  return pad83(stem, 8) + pad83(ext, 3);
}

/** VFAT LFN checksum of an 11-byte 8.3 name (matches FatComputeLfnChecksum). */
function lfnChecksum(name11: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum = ((((sum & 1) << 7) | (sum >>> 1)) + name11.charCodeAt(i)) & 0xff;
  }
  return sum;
}

/** Generate a unique 8.3 alias (NAME~N.EXT) for a long name. */
function makeShortAlias(name: string, used: Set<string>): string {
  name = name.toUpperCase();
  const dotIdx = name.lastIndexOf('.');
  let stem = (dotIdx >= 0 ? name.slice(0, dotIdx) : name).replace(/[^A-Z0-9]/g, '');
  const ext = (dotIdx >= 0 ? name.slice(dotIdx + 1) : '').replace(/[^A-Z0-9]/g, '').slice(0, 3);
  if (stem === '') stem = 'FILE';
  for (let n = 1; n <= 999999; n++) {
    const suffix = '~' + n;
    const alias = pad83(stem.slice(0, 8 - suffix.length) + suffix, 8) + pad83(ext, 3);
    if (!used.has(alias)) {
      used.add(alias);
      return alias;
    }
  }
  throw new Error(`FAT16: cannot generate a unique 8.3 alias for '${name}'`);
}

/**
 * Build the VFAT LFN dirent chain for `longname`. Returns the concatenated
 * 32-byte slots in on-disk order (highest sequence first; sequence 1 sits
 * immediately before the 8.3 entry the caller appends). 13 UTF-16 code units
 * per slot, split 5/6/2.
 */
function lfnDirents(longname: string, name11Alias: string): Uint8Array {
  const chk = lfnChecksum(name11Alias);
  const len = longname.length;
  const nSlots = Math.floor((len + 12) / 13); // ceil(len/13)
  const cu = (p: number): number => {
    // 1-based code unit
    if (p <= len) return longname.charCodeAt(p - 1);
    if (p === len + 1) return 0; // NUL terminator
    return 0xffff; // padding
  };
  const out = new Uint8Array(nSlots * 32);
  const dv = new DataView(out.buffer);
  let pos = 0;
  for (let seq = nSlots; seq >= 1; seq--) {
    const base = pos;
    out[base + 0] = seq | (seq === nSlots ? 0x40 : 0);
    out[base + 11] = 0x0f; // ATTR_LONG_NAME
    out[base + 13] = chk;
    const cbase = (seq - 1) * 13;
    for (let i = 0; i < 5; i++) dv.setUint16(base + 1 + i * 2, cu(cbase + 1 + i), true);
    for (let i = 0; i < 6; i++) dv.setUint16(base + 14 + i * 2, cu(cbase + 6 + i), true);
    for (let i = 0; i < 2; i++) dv.setUint16(base + 28 + i * 2, cu(cbase + 12 + i), true);
    pos += 32;
  }
  return out;
}

// --- Time encoding ----------------------------------------------------------

export interface FatCalendar {
  year: number;
  month: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
}

/** Default platform localtime: UTC breakdown of a unix-seconds timestamp. */
function utcCalendar(unixSeconds: number): FatCalendar {
  const d = new Date(unixSeconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
  };
}

function fatTime(cal: FatCalendar): { fatT: number; fatD: number } {
  const fatT = (cal.hour << 11) | (cal.min << 5) | Math.floor(cal.sec / 2);
  const fatD = ((cal.year - 1980) << 9) | (cal.month << 5) | cal.day;
  return { fatT: fatT & 0xffff, fatD: fatD & 0xffff };
}

// --- Entry tree -------------------------------------------------------------

interface Entry {
  name: string; // uppercased
  isDir: boolean;
  data: Uint8Array;
  children: Entry[];
  attr: number;
  firstCluster: number;
  mtime?: number; // unix seconds; undefined → volume `now`
}

function newEntry(
  name: string,
  isDir: boolean,
  opts: { data?: Uint8Array; attr?: number; mtime?: number } = {},
): Entry {
  if (name.length === 0 || name.length > 255) {
    throw new Error(`FAT16: invalid name length: '${name}'`);
  }
  return {
    name: name.toUpperCase(),
    isDir,
    data: opts.data ?? new Uint8Array(0),
    children: [],
    attr: opts.attr ?? 0,
    firstCluster: 0,
    mtime: opts.mtime,
  };
}

function findChild(dir: Entry, nameUpper: string): Entry | null {
  for (const c of dir.children) if (c.name === nameUpper) return c;
  return null;
}

// --- Public API -------------------------------------------------------------

export interface FatVolumeOptions {
  sizeMb?: number;
  volumeLabel?: string;
  volumeSerial?: number;
  sectorsPerCluster?: number;
  /** Unix-seconds timestamp for entries with no explicit mtime. */
  now?: number;
  /** Override how a unix timestamp breaks down (defaults to UTC). */
  localtime?: (unixSeconds: number) => FatCalendar;
}

export interface FatBuildContext {
  /** Partition's absolute LBA on the disk (→ BPB HiddenSectors). */
  startLba?: number;
}

export interface FatBuildResult {
  bytes: Uint8Array;
  typeCode: number;
  label: string;
  sectorSize: number;
  stats: {
    usedClusters: number;
    totalClusters: number;
    freeKb: number;
    sectorsPerCluster: number;
    sectorsPerFat: number;
  };
}

export class FatVolume {
  private sizeBytes: number;
  private spc: number;
  private label: string;
  private serial: number;
  private now: number;
  private localtime: (s: number) => FatCalendar;
  private root: Entry;

  private constructor(opts: FatVolumeOptions) {
    const sizeMb = opts.sizeMb ?? 16;
    if (sizeMb < 4) throw new Error('FAT16 volume must be at least 4 MB');
    this.sizeBytes = sizeMb * 1024 * 1024;
    this.spc = opts.sectorsPerCluster ?? defaultSpc(sizeMb);
    this.label = (opts.volumeLabel ?? 'NT').toUpperCase().slice(0, 11);
    this.now = opts.now ?? 0;
    this.serial = (opts.volumeSerial ?? this.now) >>> 0;
    this.localtime = opts.localtime ?? utcCalendar;
    this.root = newEntry('ROOT', true, { attr: ATTR_DIRECTORY, mtime: this.now });
  }

  static create(opts: FatVolumeOptions = {}): FatVolume {
    return new FatVolume(opts);
  }

  /** Partition size in bytes (the composer reads this to lay out LBAs). */
  getSizeBytes(): number {
    return this.sizeBytes;
  }

  /** mkdir -p; returns the terminal directory entry. */
  mkdir(path: string): Entry {
    let d = this.root;
    for (const part of path.replace(/\\/g, '/').split('/')) {
      if (part === '') continue;
      const existing = findChild(d, part.toUpperCase());
      if (existing === null) {
        const nd = newEntry(part, true, { attr: ATTR_DIRECTORY, mtime: this.now });
        d.children.push(nd);
        d = nd;
      } else {
        if (!existing.isDir) throw new Error(`${path}: ${part} is a file, not a dir`);
        d = existing;
      }
    }
    return d;
  }

  private splitDest(dest: string): { parent: Entry; leaf: string } {
    const parts = dest
      .replace(/\\/g, '/')
      .split('/')
      .filter((p) => p !== '');
    if (parts.length === 0) throw new Error('empty dest path');
    const leaf = parts[parts.length - 1]!;
    const parent = parts.length === 1 ? this.root : this.mkdir(parts.slice(0, -1).join('/'));
    return { parent, leaf };
  }

  /** Add an in-memory blob at `dest`. */
  addBytes(dest: string, data: Uint8Array, mtime?: number): Entry {
    const { parent, leaf } = this.splitDest(dest);
    if (findChild(parent, leaf.toUpperCase())) throw new Error(`${dest}: already exists`);
    const entry = newEntry(leaf, false, { data, attr: ATTR_ARCHIVE, mtime: mtime ?? this.now });
    parent.children.push(entry);
    return entry;
  }

  // --- Layout + emit --------------------------------------------------------

  /** Build one 32-byte FAT directory entry. */
  private dirEntry(
    name11: string,
    attr: number,
    firstCluster: number,
    size: number,
    mtime: number,
  ): Uint8Array {
    if (name11.length !== 11) throw new Error('name11 must be 11 bytes');
    let cal = this.localtime(mtime);
    if (cal.year < 1980) cal = { year: 1980, month: 1, day: 1, hour: 0, min: 0, sec: 0 };
    const { fatT, fatD } = fatTime(cal);

    const buf = new Uint8Array(32);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < 11; i++) buf[i] = name11.charCodeAt(i) & 0xff;
    buf[11] = attr;
    dv.setUint16(14, fatT, true); // creation time
    dv.setUint16(16, fatD, true); // creation date
    dv.setUint16(18, fatD, true); // last access date
    dv.setUint16(22, fatT, true); // last modify time
    dv.setUint16(24, fatD, true); // last modify date
    dv.setUint16(26, firstCluster & 0xffff, true);
    dv.setUint32(28, size >>> 0, true);
    return buf;
  }

  /** Emit dirents for one child: a single 8.3 entry, or LFN chain + 8.3 alias. */
  private childDirents(child: Entry, used: Set<string>): Uint8Array {
    const size = child.isDir ? 0 : child.data.length;
    const short = try83(child.name);
    if (short) {
      used.add(short);
      return this.dirEntry(short, child.attr, child.firstCluster, size, child.mtime ?? this.now);
    }
    const alias = makeShortAlias(child.name, used);
    const lfn = lfnDirents(child.name, alias);
    const entry = this.dirEntry(
      alias,
      child.attr,
      child.firstCluster,
      size,
      child.mtime ?? this.now,
    );
    return concatBytes([lfn, entry]);
  }

  /** Number of 32-byte dirents a child occupies. */
  private static childDirentCount(child: Entry): number {
    if (try83(child.name)) return 1;
    return Math.floor((child.name.length + 12) / 13) + 1;
  }

  build(ctx: FatBuildContext = {}): FatBuildResult {
    const startLba = ctx.startLba ?? 0;
    const img = new Uint8Array(this.sizeBytes);
    const partSectors = Math.floor(this.sizeBytes / SECTOR_SIZE);
    const spc = this.spc;

    // Solve sectors_per_fat by iteration.
    let sectorsPerFat = 1;
    let clusters = 0;
    for (;;) {
      const dataSectors =
        partSectors - RESERVED_SECTORS - NUM_FATS * sectorsPerFat - ROOT_DIR_SECTORS;
      clusters = Math.floor(dataSectors / spc);
      const neededFatBytes = (clusters + 2) * 2;
      const neededFatSectors = Math.floor((neededFatBytes + SECTOR_SIZE - 1) / SECTOR_SIZE);
      if (neededFatSectors <= sectorsPerFat) break;
      sectorsPerFat = neededFatSectors;
    }
    const totalClusters = clusters;

    const fat1Lba = RESERVED_SECTORS;
    const fat2Lba = fat1Lba + sectorsPerFat;
    const rootLba = fat2Lba + sectorsPerFat;
    const dataLba = rootLba + ROOT_DIR_SECTORS;

    // Cluster assignment.
    const fatEntries = new Map<number, number>([
      [0, 0xfff8],
      [1, 0xffff],
    ]);
    let nextCluster = 2;

    const allocClusters = (nBytes: number): number => {
      if (nBytes === 0) return 0;
      const clusterBytes = spc * SECTOR_SIZE;
      const n = Math.floor((nBytes + clusterBytes - 1) / clusterBytes);
      const first = nextCluster;
      for (let i = 0; i < n; i++) {
        const cl = nextCluster + i;
        if (cl + 1 >= totalClusters + 2) throw new Error('FAT16 volume full during layout');
        fatEntries.set(cl, i + 1 < n ? cl + 1 : CLUSTER_EOC);
      }
      nextCluster += n;
      return first;
    };

    const assign = (entry: Entry): void => {
      if (entry.isDir) {
        if (entry !== this.root) {
          let nEntries = 2; // "." and ".."
          for (const c of entry.children) nEntries += FatVolume.childDirentCount(c);
          const estBytes = Math.max(nEntries * 32, 32);
          entry.firstCluster = allocClusters(estBytes);
        }
        for (const child of entry.children) assign(child);
      } else {
        entry.firstCluster = allocClusters(entry.data.length);
      }
    };
    assign(this.root);

    // FAT16 boot sector (partition LBA 0).
    const bs = new Uint8Array(SECTOR_SIZE);
    const bdv = new DataView(bs.buffer);
    bs[0] = 0xeb;
    bs[1] = 0x3c;
    bs[2] = 0x90;
    bs.set(enc.encode('MSDOS5.0'), 3);
    bdv.setUint16(0x0b, SECTOR_SIZE, true);
    bs[0x0d] = spc;
    bdv.setUint16(0x0e, RESERVED_SECTORS, true);
    bs[0x10] = NUM_FATS;
    bdv.setUint16(0x11, ROOT_DIR_ENTRIES, true);
    let bigTotal = 0;
    if (partSectors <= 0xffff) {
      bdv.setUint16(0x13, partSectors, true);
    } else {
      bigTotal = partSectors;
      bdv.setUint16(0x13, 0, true);
    }
    bs[0x15] = 0xf8; // media descriptor
    bdv.setUint16(0x16, sectorsPerFat, true);
    bdv.setUint16(0x18, 63, true); // sectors per track
    bdv.setUint16(0x1a, 255, true); // heads
    bdv.setUint32(0x1c, startLba >>> 0, true); // HiddenSectors
    bdv.setUint32(0x20, bigTotal >>> 0, true);
    bs[0x24] = 0x80; // drive number
    bs[0x26] = 0x29; // ext boot sig
    bdv.setUint32(0x27, this.serial >>> 0, true);
    bs.set(enc.encode(pad83(this.label, 11).slice(0, 11)), 0x2b);
    bs.set(enc.encode('FAT16   '), 0x36);
    bs[0x1fe] = 0x55;
    bs[0x1ff] = 0xaa;
    img.set(bs, 0);

    // FAT tables (×2).
    const fatBytes = sectorsPerFat * SECTOR_SIZE;
    const fat = new Uint8Array(fatBytes);
    const fdv = new DataView(fat.buffer);
    for (const [cl, val] of fatEntries) fdv.setUint16(cl * 2, val, true);
    img.set(fat, fat1Lba * SECTOR_SIZE);
    img.set(fat, fat2Lba * SECTOR_SIZE);

    // Root directory.
    const rootParts: Uint8Array[] = [];
    if (this.label.length > 0) {
      rootParts.push(this.dirEntry(pad83(this.label, 11), ATTR_VOLUME_ID, 0, 0, this.now));
    }
    const rootUsed = new Set<string>();
    for (const child of this.root.children) rootParts.push(this.childDirents(child, rootUsed));
    const rootStr = concatBytes(rootParts);
    img.set(rootStr, rootLba * SECTOR_SIZE);

    // File data + subdirectory clusters.
    const writeEntry = (entry: Entry, parentCluster: number): void => {
      if (entry.isDir) {
        const parts: Uint8Array[] = [
          this.dirEntry(
            '.          ',
            ATTR_DIRECTORY,
            entry.firstCluster,
            0,
            entry.mtime ?? this.now,
          ),
          this.dirEntry('..         ', ATTR_DIRECTORY, parentCluster, 0, entry.mtime ?? this.now),
        ];
        const used = new Set<string>(['.          ', '..         ']);
        for (const child of entry.children) parts.push(this.childDirents(child, used));
        const s = concatBytes(parts);
        const lba = dataLba + (entry.firstCluster - 2) * spc;
        img.set(s, lba * SECTOR_SIZE);
        for (const child of entry.children) writeEntry(child, entry.firstCluster);
      } else {
        if (entry.firstCluster === 0) return; // empty file
        const lba = dataLba + (entry.firstCluster - 2) * spc;
        img.set(entry.data, lba * SECTOR_SIZE);
      }
    };
    for (const child of this.root.children) writeEntry(child, 0);

    const usedClusters = nextCluster - 2;
    const freeClusters = totalClusters - usedClusters;
    return {
      bytes: img,
      typeCode: PARTITION_TYPE_FAT16,
      label: this.label,
      sectorSize: SECTOR_SIZE,
      stats: {
        usedClusters,
        totalClusters,
        freeKb: Math.floor((freeClusters * spc * SECTOR_SIZE) / 1024),
        sectorsPerCluster: spc,
        sectorsPerFat,
      },
    };
  }
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
