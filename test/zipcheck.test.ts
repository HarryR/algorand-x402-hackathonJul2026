import { test, expect } from 'bun:test';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import { writeStoredZip } from '@/shared/zipwrite.ts';
import { zipPackage } from '@/cli/zip.ts';

test('zipPackage produces a STORED-only zip the guest can read', async () => {
  const { bytes } = await zipPackage('examples/hello');
  const r = checkStoredOnly(bytes);
  expect(r.ok).toBe(true);
  expect(r.entries).toBeGreaterThan(0);
});

test('a DEFLATE entry is rejected', () => {
  // Start from a valid STORED zip, then flip the central-directory compression
  // method to 8 (DEFLATE) to simulate a compressed package — no `zip` binary
  // dependency, and it exercises the checker's method-field logic directly.
  const zip = writeStoredZip([{ path: 'm/init.lua', data: new Uint8Array([0x2d, 0x2d]) }]);
  const dv = new DataView(zip.buffer);
  // Locate the central directory file header (signature "PK\x01\x02").
  const CDFH = 0x02014b50;
  let cd = -1;
  for (let i = 0; i + 4 <= zip.length; i++) {
    if (dv.getUint32(i, true) === CDFH) {
      cd = i;
      break;
    }
  }
  expect(cd).toBeGreaterThanOrEqual(0);
  dv.setUint16(cd + 10, 8, true); // central dir compression method → DEFLATE

  const r = checkStoredOnly(zip);
  expect(r.ok).toBe(false);
  expect(r.reason).toMatch(/only STORED/);
});

test('garbage input is rejected, not crashed on', () => {
  expect(checkStoredOnly(new Uint8Array([1, 2, 3])).ok).toBe(false);
  expect(checkStoredOnly(new Uint8Array(64)).ok).toBe(false);
});
