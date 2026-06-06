import { test, expect } from 'bun:test';
import { parseUsdToBaseUnits, baseUnitsToUsd } from '@/shared/units.ts';
import { PROFILES } from '@/shared/profiles.ts';

test('parses the profile prices to USDC base units', () => {
  expect(parseUsdToBaseUnits('$0.001')).toBe(1000n);
  expect(parseUsdToBaseUnits('$0.005')).toBe(5000n);
  expect(parseUsdToBaseUnits('$0.02')).toBe(20000n);
});

test('accepts plain strings and numbers (the --max-price forms)', () => {
  expect(parseUsdToBaseUnits('0.01')).toBe(10000n);
  expect(parseUsdToBaseUnits(0.01)).toBe(10000n);
  expect(parseUsdToBaseUnits(1)).toBe(1_000_000n);
});

test('rejects malformed amounts and excess precision', () => {
  expect(() => parseUsdToBaseUnits('$0.0000001')).toThrow(/decimal places/);
  expect(() => parseUsdToBaseUnits('$abc')).toThrow(/invalid USD/);
  expect(() => parseUsdToBaseUnits('')).toThrow(/invalid USD/);
});

test('baseUnitsToUsd round-trips', () => {
  expect(baseUnitsToUsd(5000n)).toBe('0.005');
  expect(baseUnitsToUsd(1_000_000n)).toBe('1');
  expect(baseUnitsToUsd(20000n)).toBe('0.02');
  expect(baseUnitsToUsd(0n)).toBe('0');
});

test('every profile price parses', () => {
  for (const p of Object.values(PROFILES)) {
    expect(parseUsdToBaseUnits(p.price)).toBeGreaterThan(0n);
  }
});
