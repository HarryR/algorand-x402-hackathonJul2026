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
 * the server never recomputes or validates it. POST /invoke/:id/:profile is
 * x402-gated via ./payment.ts (verify+settle through the facilitator, priced per
 * profile) when config.paymentsEnabled; otherwise it runs free.
 */

import { config } from '@/shared/config.ts';
import { PROFILES, getProfile } from '@/shared/profiles.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import { assertValidId, assertValidPackageName, assertValidRequire } from '@/shared/validate.ts';
import type {
  InvokeSpec,
  InvokeStatus,
  InvokeOutput,
  InvokeDiscovery,
  InvokeError,
  PackageRef,
  SettlementReceipt,
  SessionStart,
} from '@/shared/protocol.ts';
import {
  savePackage,
  packageFile,
  argsHash as hashArgs,
  getInvocation,
  putInvocation,
  type Invocation,
} from './store.ts';
import { launch, launchSession } from './vm.ts';
import { createSession, getSession, type Session } from './sessions.ts';
import { kernelPath } from './artifacts.ts';
import { paymentsRequired, hasPaymentHeader, challenge, settle } from './payment.ts';

/** Per-connection state carried on each serial WebSocket. */
interface SerialWsData {
  id: string;
  session?: Session;
}

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
  assertValidId(id);
  const inv = getInvocation(id);
  if (!inv) return err(`unknown invocation "${id}"`, 404);
  return json(statusDoc(inv));
}

function handleOutput(id: string): Response {
  assertValidId(id);
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

async function handlePay(req: Request, id: string, profileName: string): Promise<Response> {
  assertValidId(id); // untrusted: id becomes an instance dir + boot-log path
  const profile = getProfile(profileName); // throws → 400

  // One paid profile per id: reject a second payment with 409 + status.
  const existing = getInvocation(id);
  if (existing && existing.state !== 'expired') {
    return json(statusDoc(existing), 409);
  }

  // x402 gate. Issue the 402 from the URL profile alone — BEFORE reading the
  // (potentially large) multipart body — when no payment is presented. The
  // actual verify+settle happens after the packages are stored, just before
  // launch (pay-first: a settled payment then runs; a later VM failure is not
  // refunded). Disabled entirely when config.paymentsEnabled is false.
  if (paymentsRequired() && !hasPaymentHeader(req)) {
    return challenge(profile, new URL(req.url).pathname);
  }

  // A session (?mode=session) keeps the VM alive as an interactive serial shell;
  // it needs neither a module nor packages (a bare REPL is valid), so spec and
  // packages are optional in that mode. A one-shot invoke requires both.
  const sessionMode = new URL(req.url).searchParams.get('mode') === 'session';

  // Parse the multipart body: zero or more "package" zips + a JSON "spec" field.
  const form = await req.formData();
  const specRaw = form.get('spec');
  let spec: InvokeSpec = { require: '', args: [] };
  if (typeof specRaw === 'string') {
    try {
      spec = JSON.parse(specRaw) as InvokeSpec;
    } catch {
      return err('"spec" is not valid JSON');
    }
  } else if (!sessionMode) {
    return err('expected a JSON "spec" field { require, args }');
  }
  if (spec.require) {
    if (typeof spec.require !== 'string') return err('spec.require must be a dotted module string');
    assertValidRequire(spec.require); // untrusted: drives require() in the guest
  } else if (!sessionMode) {
    return err('spec.require must be a dotted module string');
  }
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];

  const files = form.getAll('package').filter((f) => typeof f !== 'string');
  if (files.length === 0 && !sessionMode) return err('expected at least one "package" zip');
  if (files.length > config.maxPackagesPerInvoke) {
    return err(`too many packages: ${files.length} > ${config.maxPackagesPerInvoke} max`, 413);
  }

  // Store packages content-addressed; the upload filename becomes the in-zip
  // pkg entry (user code in the Lua namespace), so validate it as a path-safe
  // name. Reject DEFLATE zips up front — the MicroNT loader reads STORED only —
  // and cap the aggregate upload to bound memory/disk.
  const packages: PackageRef[] = [];
  let totalBytes = 0;
  for (const f of files) {
    assertValidPackageName(f.name); // no slashes/.. ; "<stem>.zip"
    const bytes = new Uint8Array(await f.arrayBuffer());
    totalBytes += bytes.byteLength;
    if (totalBytes > config.maxUploadBytes) {
      return err(`upload too large: exceeds ${config.maxUploadBytes} bytes total`, 413);
    }
    const check = checkStoredOnly(bytes);
    if (!check.ok) {
      return err(`package "${f.name}" must be a STORED (uncompressed) zip: ${check.reason}`);
    }
    const hash = await savePackage(bytes);
    packages.push({ name: f.name, hash });
  }

  // Verify + settle the payment before running (pay-first). On failure the
  // client is re-challenged with a fresh 402. Reads req.headers only (the body
  // is already consumed above). No-op when payments are disabled.
  let receipt: SettlementReceipt | undefined;
  let paymentResponseHeader: string | undefined;
  let settleMs: number | undefined;
  if (paymentsRequired()) {
    const settleStart = Date.now();
    try {
      const settled = await settle(req, profile);
      receipt = settled.receipt;
      paymentResponseHeader = settled.responseHeader;
      settleMs = Date.now() - settleStart;
    } catch (e) {
      return challenge(
        profile,
        new URL(req.url).pathname,
        e instanceof Error ? e.message : undefined,
      );
    }
  }

  // Record before running so a concurrent re-pay sees 'running'.
  const inv: Invocation = {
    id,
    state: 'running',
    packages,
    require: spec.require,
    argsHash: await hashArgs(args),
    paidProfile: profile.name,
    receipt,
    expiresAtMs: Number.MAX_SAFE_INTEGER, // set once the run completes
  };
  putInvocation(inv);

  // Session mode: boot the VM and keep it alive as an interactive serial console
  // instead of running to a framed result. The client attaches over WS at
  // /invoke/:id/serial. The session hard-caps at the profile's wall-clock; the
  // invocation expires in lockstep so a re-pay is rejected until then.
  if (sessionMode) {
    const sess = await launchSession({
      id,
      packages: packages.map((p) => ({ name: p.name, path: packageFile(p.hash) })),
      input: { require: spec.require, args },
      profile,
    });
    createSession(id, sess.channel, {
      maxWallMs: profile.maxWallMs,
      maxOutputBytes: profile.maxOutputBytes,
    });
    // Reap the instance dir once the VM is gone (cap / output-cap / exit).
    void sess.channel.exited.then(() => sess.cleanup()).catch(() => {});
    inv.expiresAtMs = Date.now() + profile.maxWallMs;
    inv.metering = { vmWallMs: 0, profile: profile.name, settleMs };
    putInvocation(inv);

    const res = json({
      ok: true,
      id,
      mode: 'session',
      expiresAt: inv.expiresAtMs,
      serial: `/invoke/${encodeURIComponent(id)}/serial`,
      receipt,
    } satisfies SessionStart);
    if (paymentResponseHeader) res.headers.set('PAYMENT-RESPONSE', paymentResponseHeader);
    return res;
  }

  try {
    const { output, vmWallMs } = await launch({
      id,
      packages: packages.map((p) => ({ name: p.name, path: packageFile(p.hash) })),
      input: { require: spec.require, args },
      profile,
    });
    inv.expiresAtMs = Date.now() + profile.retainSeconds * 1000;
    inv.metering = { vmWallMs, profile: profile.name, settleMs };
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
  // Echo the output on the paying request, with the settlement header (x402
  // PAYMENT-RESPONSE) attached so the client can read the on-chain confirmation.
  const out = handleOutput(id);
  if (paymentResponseHeader) out.headers.set('PAYMENT-RESPONSE', paymentResponseHeader);
  return out;
}

// --- Dispatch ---------------------------------------------------------------

const server = Bun.serve<SerialWsData>({
  port: config.orchestratorPort,
  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname === '/health') return json({ ok: true });
      if (req.method === 'GET' && pathname === '/profiles') return json(PROFILES);
      if (req.method === 'GET' && pathname === '/invoke') return handleDiscovery();

      // Serial console attach — upgrade to a WebSocket. Auth is the id (same trust
      // model as /output): the session must be live, else open() closes it.
      const serial = pathname.match(/^\/invoke\/([^/]+)\/serial$/);
      if (req.method === 'GET' && serial) {
        const id = decodeURIComponent(serial[1]!);
        assertValidId(id);
        if (server.upgrade(req, { data: { id } })) return undefined;
        return err('expected a WebSocket upgrade', 426);
      }

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
      // Bad request — ValidationError (bad id/name/require), getProfile, JSON, etc.
      return err(e instanceof Error ? e.message : String(e), 400);
    }
  },

  // Serial console: one WebSocket per attachment; many may share a session id
  // (multi-attach). Output is broadcast to all; any client's bytes feed serial in.
  websocket: {
    open(ws) {
      const session = getSession(ws.data.id);
      if (!session) {
        ws.close(1011, 'no live session for that id');
        return;
      }
      ws.data.session = session;
      session.attach(ws); // replays scrollback, then live-streams
    },
    message(ws, message) {
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
      ws.data.session?.input(new Uint8Array(bytes));
    },
    close(ws) {
      ws.data.session?.detach(ws);
    },
  },
});

console.log(`lualambda orchestrator listening on http://localhost:${server.port}`);

// Materialize the embedded kernel to a real on-disk path eagerly, so a broken
// extraction fails loudly at boot rather than on the first invoke. Memoized, so
// launch() reuses the same path. Non-VM routes (health/status) still work even
// if this warns, so we don't exit the process.
kernelPath()
  .then((p) => console.log(`kernel ready at ${p}`))
  .catch((e) => console.error(`FATAL: could not materialize kernel: ${e?.message ?? e}`));

if (paymentsRequired()) {
  console.log(`payments ENABLED → payTo=${config.payToAddress} asset=${config.usdcAsaId}`);
} else {
  console.warn('payments DISABLED (free) — set LUALAMBDA_PAY_TO to enforce x402');
}
