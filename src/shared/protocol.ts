/**
 * Wire contracts shared between CLI ↔ orchestrator ↔ guest.
 *
 * Keep these dependency-free: the CLI cross-compiles to a single binary, the
 * orchestrator runs on the server, and the guest agent (src/guest/main.lua) plus
 * the host-sent stager (src/orchestrator/stager.ts) speak the matching Lua side.
 *
 * Execution model: there is no "deployed function." An invocation is a set of
 * package zips + a module to `require` + an array of args. The zips are dropped
 * into the guest's package dir (\SystemRoot\pkg\); MicroNT's Lua loader resolves
 * `require('blah.dorp')` transparently to \SystemRoot\pkg\blah.zip\blah\dorp.lua.
 */

import type { ProfileName } from './profiles.ts';

// --- Invoke (idempotency model) ---------------------------------------------
//
// An invocation is keyed by an OPAQUE idempotency id chosen by the client — a
// deterministic hash of its inputs, or a human nametag. The server never
// recomputes or validates it; it's purely a dedup key. Routes:
//
//   GET  /invoke                  — discovery: profiles, prices, URL scheme
//                                   (agent-accessible; future MCP endpoint).
//   GET  /invoke/:id              — status only (state + hashes + expiry).
//   POST /invoke/:id/:profile     — priced, x402-gated. One paid profile per id.
//                                   multipart: the package zips + a JSON field
//                                   { require, args }.
//   GET  /invoke/:id/output       — retained output; 410 once expired.
//
// At most one successful payment per id. Choosing the profile = choosing the
// price, the retention duration, and the max retained output size.

/** An opaque, client-chosen idempotency id (hash or nametag). */
export type IdempotencyId = string;

export type InvokeState =
  | 'running' // paid; VM is executing
  | 'done' // finished; output retained
  | 'failed' // finished with a guest error; status retained
  | 'expired'; // retention window elapsed; output gone

/**
 * The JSON field accompanying the uploaded package zips on
 * `POST /invoke/:id/:profile` (multipart field name "spec").
 */
export interface InvokeSpec {
  /** Dotted module to `require`, e.g. "hello" or "blah.dorp". */
  require: string;
  /** Positional args passed to the required module's `function(args)`. */
  args: string[];
}

/** One uploaded package: its filename in the pkg dir and content hash. */
export interface PackageRef {
  /** Filename as placed in the pkg dir, e.g. "blah.zip". */
  name: string;
  /** sha256 of the zip bytes, hex. */
  hash: string;
}

/**
 * Status document — `GET /invoke/:id`. Deliberately does NOT include the args
 * (they may carry private data) nor the price table; only state + the hashes of
 * what is being / was run, plus retention info.
 */
export interface InvokeStatus {
  id: IdempotencyId;
  state: InvokeState;
  /** The packages (name + hash) this id is bound to. */
  packages: PackageRef[];
  /** The module that was required. */
  require: string;
  /** sha256 of the canonicalized args, hex. Lets a client confirm its inputs. */
  argsHash: string;
  /** The profile that was paid for. */
  paidProfile: ProfileName;
  /** ISO timestamp the retained output expires. */
  expiresAt: string;
}

/** Successful `200` from `GET /invoke/:id/output`. */
export interface InvokeOutput {
  ok: true;
  id: IdempotencyId;
  /** Whatever the required module returned, JSON-serialized then parsed. */
  result: unknown;
  /** Settlement receipt (present once x402 is wired — Milestone 2). */
  receipt?: SettlementReceipt;
  metering: Metering;
}

/**
 * Discovery document — `GET /invoke`. Agent-accessible description of the
 * available profiles, their prices, and the URL scheme. A small MCP endpoint
 * will surface this in the future.
 */
export interface InvokeDiscovery {
  /** Templated routes, e.g. "POST /invoke/{id}/{profile}". */
  routes: {
    status: string;
    pay: string;
    output: string;
  };
  /** How to call the pay route. */
  pay: {
    /** multipart: package zips under this field + a JSON "spec" field. */
    contentType: 'multipart/form-data';
    packagesField: string;
    specField: string;
    spec: { require: 'string (dotted module)'; args: 'string[]' };
  };
  profiles: Array<{
    name: ProfileName;
    price: string;
    /** Output retention window, seconds. */
    retainSeconds: number;
    /** Max retained output, bytes. */
    maxOutputBytes: number;
  }>;
}

export interface InvokeError {
  ok: false;
  error: string;
}

export interface SettlementReceipt {
  /** Algorand transaction id of the settled axfer. */
  txid: string;
  network: string;
  explorerUrl: string;
}

export interface Metering {
  /** Wall-clock the guest VM was alive, ms. */
  vmWallMs: number;
  profile: ProfileName;
}

// --- Guest contract ---------------------------------------------------------

/**
 * What the host needs the guest to run: which baked-in module to `require` and
 * the positional args. The host-sent stager (src/orchestrator/stager.ts)
 * interpolates these and emits the result framed by the sentinels below; the
 * package zips are baked into the initrd pkg dir out of band.
 */
export interface GuestInput {
  /** Dotted module to `require`. */
  require: string;
  args: string[];
}

export interface GuestOutput {
  ok: boolean;
  /** Present when ok: the required module's return value. */
  result?: unknown;
  /** Present when !ok: a Lua error message. */
  error?: string;
}

/**
 * Sentinel lines framing the single JSON result line the stager sends back over
 * the connect-back socket (parsed host-side by extractFramedResult()).
 */
export const RESULT_BEGIN = '---LUALAMBDA-RESULT-BEGIN---';
export const RESULT_END = '---LUALAMBDA-RESULT-END---';
