/**
 * Client payment seam — turns the plain CLI fetch into an x402-paying fetch.
 *
 * Uses the framework-agnostic @x402-avm/core client + the exact-AVM scheme. We
 * implement the small 402→sign→retry loop ourselves (rather than @x402/fetch) so
 * every type comes from one package family and so `--max-price` can abort BEFORE
 * signing. On a 402 the registered exact-AVM scheme signs an Algorand USDC
 * payment with the wallet's signer; the request is retried with the payment
 * header (`PAYMENT-SIGNATURE`).
 */

import { x402Client } from '@x402-avm/core/client';
import { x402HTTPClient } from '@x402-avm/core/http';
import type { PaymentRequirements } from '@x402-avm/core/types';
import { registerExactAvmScheme } from '@x402-avm/avm/exact/client';
import { toClientAvmSigner } from '@x402-avm/avm';
import { parseUsdToBaseUnits, baseUnitsToUsd } from '@/shared/units.ts';
import { config } from '@/shared/config.ts';
import { signerKeyBase64 } from './wallet.ts';

/**
 * Pure requirement selector (testable without the SDK): pick the cheapest
 * requirement whose amount is within `ceilingBaseUnits`; throw if all exceed it.
 * With no ceiling, returns the first (SDK default behavior).
 */
export function selectRequirement(
  requirements: PaymentRequirements[],
  ceilingBaseUnits?: bigint,
): PaymentRequirements {
  if (requirements.length === 0) throw new Error('no payment requirements offered');
  const cheapest = (rs: PaymentRequirements[]) =>
    rs.reduce((m, r) => (BigInt(r.amount) < BigInt(m.amount) ? r : m));
  if (ceilingBaseUnits === undefined) return requirements[0]!;

  const affordable = requirements.filter((r) => BigInt(r.amount) <= ceilingBaseUnits);
  if (affordable.length === 0) {
    throw new Error(
      `cheapest payment requirement ($${baseUnitsToUsd(BigInt(cheapest(requirements).amount))}) ` +
        `exceeds --max-price $${baseUnitsToUsd(ceilingBaseUnits)}`,
    );
  }
  return cheapest(affordable);
}

/** A fetch-like signature (looser than `typeof fetch`, which requires `preconnect`). */
export type PayingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Build an x402-paying fetch. `maxPriceUsd` (from `--max-price`) caps what the
 * client will sign; selection/abort happens before any signing.
 */
export function payingFetch(maxPriceUsd?: number): PayingFetch {
  const ceiling = maxPriceUsd === undefined ? undefined : parseUsdToBaseUnits(maxPriceUsd);
  const signer = toClientAvmSigner(signerKeyBase64());

  const core = new x402Client((_version, requirements) => selectRequirement(requirements, ceiling));
  registerExactAvmScheme(core, { signer, algodConfig: { algodUrl: config.algodUrl } });
  const http = new x402HTTPClient(core);

  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.status !== 402) return res;

    // Parse requirements, create + sign the payment, retry once with the header.
    const paymentRequired = http.getPaymentRequiredResponse(
      (name) => res.headers.get(name),
      await res
        .clone()
        .json()
        .catch(() => undefined),
    );
    const payload = await http.createPaymentPayload(paymentRequired); // may throw (max-price abort)
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(payHeaders)) headers.set(k, v);
    return fetch(input, { ...init, headers });
  };
}
