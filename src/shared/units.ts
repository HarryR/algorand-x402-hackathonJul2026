/**
 * USD ↔ token base-units conversion (USDC has 6 decimals).
 *
 * The x402 server SDK converts a `price: '$0.005'` string to base units itself,
 * so this is used CLIENT-side to enforce the `--max-price` ceiling against the
 * `amount` (base-units string) in a 402's payment requirements. Pure integer/
 * string math — no floats — so it's exact and offline-testable.
 */

export const USDC_DECIMALS = 6;

/**
 * Parse a USD amount (`'$0.005'`, `'0.005'`, or `0.005`) to token base units.
 * Throws on malformed input or more fractional digits than `decimals`.
 */
export function parseUsdToBaseUnits(usd: string | number, decimals = USDC_DECIMALS): bigint {
  const raw = (typeof usd === 'number' ? usd.toString() : usd).trim().replace(/^\$/, '');
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`invalid USD amount: ${JSON.stringify(usd)}`);
  }
  const [whole = '0', frac = ''] = raw.split('.');
  if (frac.length > decimals) {
    throw new Error(`USD amount ${JSON.stringify(usd)} has more than ${decimals} decimal places`);
  }
  const fracPadded = frac.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

/** Format token base units back to a decimal USD string (no `$`). */
export function baseUnitsToUsd(units: bigint, decimals = USDC_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const frac = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
