/**
 * Persistence for invocations and their package zips.
 *
 * There is no "deployed function" — an invocation arrives with its package zips
 * (multipart) on the paying request. We store the zip bytes content-addressed by
 * sha256 (cheap dedup if the same package recurs) and hold invocation records in
 * memory, expiring their retained output per the paid profile's retainSeconds.
 *
 * Layout under config.dataDir:
 *   pkg/<sha256>.zip       — content-addressed package bytes
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/shared/config.ts';
import type {
  IdempotencyId,
  InvokeState,
  PackageRef,
  SettlementReceipt,
  Metering,
} from '@/shared/protocol.ts';
import type { ProfileName } from '@/shared/profiles.ts';

// --- Hashing ----------------------------------------------------------------

/** sha256 (hex) of bytes or a UTF-8 string. */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable hash of the positional args (order-significant). */
export function argsHash(args: string[]): Promise<string> {
  return sha256Hex(JSON.stringify(args));
}

// --- Package storage (content-addressed) ------------------------------------

function pkgPath(hash: string): string {
  return join(config.dataDir, 'pkg', `${hash}.zip`);
}

/** Store one package zip, return its content hash. Idempotent by content. */
export async function savePackage(zip: ArrayBuffer | Uint8Array): Promise<string> {
  const hash = await sha256Hex(zip);
  const f = Bun.file(pkgPath(hash));
  if (!(await f.exists())) {
    await mkdir(join(config.dataDir, 'pkg'), { recursive: true });
    await Bun.write(pkgPath(hash), zip);
  }
  return hash;
}

/** Filesystem path to a stored package by hash (for the VM launcher). */
export function packageFile(hash: string): string {
  return pkgPath(hash);
}

// --- Invocations (idempotency) ----------------------------------------------

/**
 * One invocation, keyed by the client's idempotency id. Created on first
 * successful payment; at most one per id. `result`/`receipt`/`metering` are
 * populated once the run finishes and are dropped when the record expires.
 */
export interface Invocation {
  id: IdempotencyId;
  state: InvokeState;
  /** Packages bound to this id (name + content hash). */
  packages: PackageRef[];
  /** Dotted module that was required. */
  require: string;
  /** sha256 of the canonicalized args, hex. */
  argsHash: string;
  paidProfile: ProfileName;
  /** epoch ms when the retained output expires. */
  expiresAtMs: number;
  result?: unknown;
  receipt?: SettlementReceipt;
  metering?: Metering;
}

const invocations = new Map<IdempotencyId, Invocation>();

/** Fetch an invocation, lazily expiring it (and dropping its output) if due. */
export function getInvocation(id: IdempotencyId): Invocation | undefined {
  const inv = invocations.get(id);
  if (!inv) return undefined;
  if (inv.state !== 'expired' && Date.now() >= inv.expiresAtMs) {
    inv.state = 'expired';
    delete inv.result;
    delete inv.receipt;
    delete inv.metering;
  }
  return inv;
}

export function putInvocation(inv: Invocation): void {
  invocations.set(inv.id, inv);
}
