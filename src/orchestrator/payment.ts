/**
 * Server payment seam — x402 gating for POST /invoke/:id/:profile.
 *
 * The orchestrator holds NO key: it builds payment requirements from the
 * profile's price + config and delegates verify/settle to the managed
 * facilitator (which fee-sponsors). Payments are enforced only when
 * `config.paymentsEnabled` (payTo + USDC ASA set); otherwise the free dev/E2E
 * path runs untouched.
 *
 * Built on the framework-agnostic @x402-avm/core resource server, wired into
 * Bun.serve by hand (no Hono). Header names (pinned to the SDK): the 402 carries
 * PAYMENT-REQUIRED; the client sends PAYMENT-SIGNATURE; we return PAYMENT-RESPONSE
 * on success.
 */

import { x402ResourceServer, HTTPFacilitatorClient } from '@x402-avm/core/server';
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from '@x402-avm/core/http';
import { registerExactAvmScheme } from '@x402-avm/avm/exact/server';
import type { Network } from '@x402-avm/core/types';
import { config } from '@/shared/config.ts';
import type { ResourceProfile } from '@/shared/profiles.ts';
import type { SettlementReceipt } from '@/shared/protocol.ts';

/** CAIP-2 network id, narrowed to the SDK's `${chain}:${ref}` template type. */
const NETWORK = config.algorandNetwork as Network;

export function paymentsRequired(): boolean {
  return config.paymentsEnabled;
}

/** The client sends the signed payment under this header (SDK-pinned name). */
export function hasPaymentHeader(req: Request): boolean {
  return req.headers.get('PAYMENT-SIGNATURE') != null || req.headers.get('X-PAYMENT') != null;
}

// Lazily constructed + initialized resource server (initialize() fetches the
// facilitator's supported kinds once).
let serverPromise: Promise<x402ResourceServer> | null = null;

function getResourceServer(): Promise<x402ResourceServer> {
  if (!serverPromise) {
    serverPromise = (async () => {
      const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
      const rs = new x402ResourceServer(facilitator);
      registerExactAvmScheme(rs); // wildcard algorand:* — facilitator signs
      await rs.initialize();
      return rs;
    })();
  }
  return serverPromise;
}

function resourceConfig(profile: ResourceProfile) {
  return {
    scheme: 'exact',
    payTo: config.payToAddress,
    price: profile.price, // '$0.005' — the SDK converts to USDC base units
    network: NETWORK,
    maxTimeoutSeconds: 120,
    extra: { asset: config.usdcAsaId },
  };
}

/** Build the 402 response (PAYMENT-REQUIRED header) for a profile. */
export async function challenge(
  profile: ResourceProfile,
  resourceUrl: string,
  error?: string,
): Promise<Response> {
  const rs = await getResourceServer();
  const requirements = await rs.buildPaymentRequirements(resourceConfig(profile));
  const paymentRequired = await rs.createPaymentRequiredResponse(
    requirements,
    {
      url: resourceUrl,
      description: `lualambda ${profile.name} invocation`,
      mimeType: 'application/json',
    },
    error,
  );
  return new Response(
    JSON.stringify({ error: error ?? 'payment required', accepts: requirements }),
    {
      status: 402,
      headers: {
        'content-type': 'application/json',
        'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired),
      },
    },
  );
}

/**
 * Verify + settle the inbound payment for a profile. Returns the settlement
 * receipt on success; throws on missing/invalid/failed payment (caller
 * re-challenges with 402). Reads only `req.headers` — safe after the body has
 * been consumed.
 */
export async function settle(
  req: Request,
  profile: ResourceProfile,
): Promise<{ receipt: SettlementReceipt; responseHeader: string }> {
  const header = req.headers.get('PAYMENT-SIGNATURE') ?? req.headers.get('X-PAYMENT');
  if (!header) throw new Error('no payment header');

  const rs = await getResourceServer();
  const payload = decodePaymentSignatureHeader(header);
  const requirements = await rs.buildPaymentRequirements(resourceConfig(profile));
  const matched = rs.findMatchingRequirements(requirements, payload) ?? requirements[0];
  if (!matched) throw new Error('no matching payment requirement');

  const verified = await rs.verifyPayment(payload, matched);
  if (!verified.isValid) throw new Error(`payment invalid: ${verified.invalidReason ?? 'unknown'}`);

  const settled = await rs.settlePayment(payload, matched);
  if (!settled.success) throw new Error(`settlement failed: ${settled.errorReason ?? 'unknown'}`);

  const receipt: SettlementReceipt = {
    txid: settled.transaction,
    network: settled.network ?? config.algorandNetwork,
    explorerUrl: `${config.explorerTxBase}/${settled.transaction}`,
  };
  return { receipt, responseHeader: encodePaymentResponseHeader(settled) };
}
