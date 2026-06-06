/**
 * Orchestrator HTTP API.
 *
 * Idempotency model (see src/shared/protocol.ts):
 *   GET  /health               — liveness.
 *   GET  /profiles             — resource/price tiers (raw).
 *   GET  /invoke               — discovery: profiles, prices, URL scheme.
 *   GET  /invoke/:id           — status only (state + hashes + expiry).
 *   POST /invoke/:id/:profile  — priced, x402-gated; one paid profile per id.
 *                                multipart: package zips + a JSON "spec" field
 *                                { require, args }.
 *   GET  /invoke/:id/output    — retained output; 410 once expired.
 *
 * There is no "deployed function": the package zips ride along on the paying
 * request. The id is opaque and client-chosen (deterministic hash or nametag);
 * the server never recomputes or validates it. x402's paymentMiddleware will
 * gate POST /invoke/:id/:profile in Milestone 2 — priced per profile path. The
 * `requirePayment` seam below marks exactly where that goes.
 */

import { config } from '@/shared/config.ts';
import { PROFILES, getProfile, type ResourceProfile } from '@/shared/profiles.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import type {
  InvokeSpec,
  InvokeStatus,
  InvokeOutput,
  InvokeDiscovery,
  InvokeError,
  PackageRef,
} from '@/shared/protocol.ts';
import {
  savePackage,
  packageFile,
  argsHash as hashArgs,
  getInvocation,
  putInvocation,
  type Invocation,
} from './store.ts';
import { launch } from './vm.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message } satisfies InvokeError, status);
}

function statusDoc(inv: Invocation): InvokeStatus {
  return {
    id: inv.id,
    state: inv.state,
    packages: inv.packages,
    require: inv.require,
    argsHash: inv.argsHash,
    paidProfile: inv.paidProfile,
    expiresAt: new Date(inv.expiresAtMs).toISOString(),
  };
}

// --- Routes -----------------------------------------------------------------

function handleDiscovery(): Response {
  const doc: InvokeDiscovery = {
    routes: {
      status: 'GET /invoke/{id}',
      pay: 'POST /invoke/{id}/{profile}',
      output: 'GET /invoke/{id}/output',
    },
    pay: {
      contentType: 'multipart/form-data',
      packagesField: 'package',
      specField: 'spec',
      spec: { require: 'string (dotted module)', args: 'string[]' },
    },
    profiles: Object.values(PROFILES).map((p) => ({
      name: p.name,
      price: p.price,
      retainSeconds: p.retainSeconds,
      maxOutputBytes: p.maxOutputBytes,
    })),
  };
  return json(doc);
}

function handleStatus(id: string): Response {
  const inv = getInvocation(id);
  if (!inv) return err(`unknown invocation "${id}"`, 404);
  return json(statusDoc(inv));
}

function handleOutput(id: string): Response {
  const inv = getInvocation(id);
  if (!inv) return err(`unknown invocation "${id}"`, 404);
  if (inv.state === 'expired') return err(`output for "${id}" has expired`, 410);
  if (inv.state === 'running') return err(`invocation "${id}" is still running`, 409);
  if (inv.state === 'failed') return err('invocation failed in the guest', 500);
  return json({
    ok: true,
    id: inv.id,
    result: inv.result,
    receipt: inv.receipt,
    metering: inv.metering!,
  } satisfies InvokeOutput);
}

/**
 * Payment seam. Milestone 2 replaces this with x402's paymentMiddleware in front
 * of the POST /invoke/:id/:profile route (priced per `profile.price`). Until
 * then we treat the request as paid so the run/retain/read flow is testable.
 */
async function requirePayment(_req: Request, _profile: ResourceProfile): Promise<void> {
  // dev: payment is a no-op until Milestone 2
}

async function handlePay(req: Request, id: string, profileName: string): Promise<Response> {
  const profile = getProfile(profileName); // throws → 400

  // One paid profile per id: reject a second payment with 409 + status.
  const existing = getInvocation(id);
  if (existing && existing.state !== 'expired') {
    return json(statusDoc(existing), 409);
  }

  // Parse the multipart body: one or more "package" zips + a JSON "spec" field.
  const form = await req.formData();
  const specRaw = form.get('spec');
  if (typeof specRaw !== 'string') return err('expected a JSON "spec" field { require, args }');
  let spec: InvokeSpec;
  try {
    spec = JSON.parse(specRaw) as InvokeSpec;
  } catch {
    return err('"spec" is not valid JSON');
  }
  if (!spec.require || typeof spec.require !== 'string') {
    return err('spec.require must be a dotted module string');
  }
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];

  const files = form.getAll('package').filter((f) => typeof f !== 'string');
  if (files.length === 0) return err('expected at least one "package" zip');

  // Store packages content-addressed; keep their upload filenames for the pkg dir.
  // Reject DEFLATE zips up front — the MicroNT loader reads STORED entries only.
  const packages: PackageRef[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const check = checkStoredOnly(bytes);
    if (!check.ok) {
      return err(`package "${f.name}" must be a STORED (uncompressed) zip: ${check.reason}`);
    }
    const hash = await savePackage(bytes);
    packages.push({ name: f.name || `${hash}.zip`, hash });
  }

  await requirePayment(req, profile); // x402 gate goes here (Milestone 2)

  // Record before running so a concurrent re-pay sees 'running'.
  const inv: Invocation = {
    id,
    state: 'running',
    packages,
    require: spec.require,
    argsHash: await hashArgs(args),
    paidProfile: profile.name,
    expiresAtMs: Number.MAX_SAFE_INTEGER, // set once the run completes
  };
  putInvocation(inv);

  try {
    const { output, vmWallMs } = await launch({
      packages: packages.map((p) => ({ name: p.name, path: packageFile(p.hash) })),
      input: { require: spec.require, args },
      profile,
    });
    inv.expiresAtMs = Date.now() + profile.retainSeconds * 1000;
    inv.metering = { vmWallMs, profile: profile.name };
    if (output.ok) {
      inv.state = 'done';
      inv.result = output.result;
    } else {
      inv.state = 'failed';
    }
  } catch (e) {
    inv.state = 'failed';
    inv.expiresAtMs = Date.now() + profile.retainSeconds * 1000;
    putInvocation(inv);
    return err(e instanceof Error ? e.message : String(e), 500);
  }

  putInvocation(inv);
  return handleOutput(id); // echo the output on the paying request
}

// --- Dispatch ---------------------------------------------------------------

const server = Bun.serve({
  port: config.orchestratorPort,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname === '/health') return json({ ok: true });
      if (req.method === 'GET' && pathname === '/profiles') return json(PROFILES);
      if (req.method === 'GET' && pathname === '/invoke') return handleDiscovery();

      const output = pathname.match(/^\/invoke\/([^/]+)\/output$/);
      if (req.method === 'GET' && output) {
        return handleOutput(decodeURIComponent(output[1]!));
      }
      const pay = pathname.match(/^\/invoke\/([^/]+)\/([^/]+)$/);
      if (req.method === 'POST' && pay) {
        return await handlePay(req, decodeURIComponent(pay[1]!), decodeURIComponent(pay[2]!));
      }
      const status = pathname.match(/^\/invoke\/([^/]+)$/);
      if (req.method === 'GET' && status) {
        return handleStatus(decodeURIComponent(status[1]!));
      }
      return err('not found', 404);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 400);
    }
  },
});

console.log(`lualambda orchestrator listening on http://localhost:${server.port}`);
