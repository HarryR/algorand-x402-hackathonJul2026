import { test, expect } from 'bun:test';
import { selectRequirement } from '@/cli/payment.ts';
import type { PaymentRequirements } from '@x402-avm/core/types';

// Minimal requirement objects — only the fields the selector reads.
function req(amount: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'algorand:test',
    asset: '10458941',
    amount,
    payTo: 'X',
    maxTimeoutSeconds: 120,
    extra: {},
  } as unknown as PaymentRequirements;
}

test('no ceiling → first requirement (SDK default)', () => {
  expect(selectRequirement([req('5000'), req('1000')]).amount).toBe('5000');
});

test('ceiling → cheapest within budget', () => {
  const r = selectRequirement([req('20000'), req('5000'), req('1000')], 5000n);
  expect(r.amount).toBe('1000');
});

test('ceiling picks the at-limit requirement', () => {
  expect(selectRequirement([req('5000'), req('20000')], 5000n).amount).toBe('5000');
});

test('all exceed ceiling → throws with a clear USD message', () => {
  expect(() => selectRequirement([req('5000'), req('20000')], 1000n)).toThrow(
    /exceeds --max-price \$0\.001/,
  );
});

test('empty requirements → throws', () => {
  expect(() => selectRequirement([])).toThrow(/no payment requirements/);
});
