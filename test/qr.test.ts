import { test, expect } from 'bun:test';
import { algorandUri, addressQr } from '@/cli/qr.ts';

const ADDR = 'KY2EMCTJE5MHU7A24O6DGV22SGZIQWMLLJ5OWIHDVWTNYRBMHBUUTJCDE4';

test('algorandUri builds the amount-less Algorand URI', () => {
  expect(algorandUri(ADDR)).toBe(`algorand://${ADDR}`);
});

test('addressQr renders a non-empty terminal QR', async () => {
  const out = await addressQr(ADDR);
  expect(out.length).toBeGreaterThan(0);
  // Terminal QR uses half-block glyphs; assert at least one is present.
  expect(/[▀-▟]/.test(out)).toBe(true);
});
