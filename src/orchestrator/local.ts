/**
 * Shared "run a package in a VM" core — the orchestrator's post-payment sequence,
 * minus HTTP/x402/the invocation record.
 *
 * Both the server (POST /invoke/:id/:profile, after settling payment) and the
 * client's `invoke --local-test` need the same steps: validate the package
 * names + require, content-address the zips into the workdir pkg store, derive
 * the idempotency id, and launch a guest VM. Factoring it here lets local-test be
 * a FAITHFUL dry-run of a real invoke (same id, same store, same launch path) so
 * "it worked locally" actually predicts the paid path.
 *
 * `buildLaunchPlan` is the pre-launch half (validate → store → id → profile),
 * separated so it can be unit-tested without booting QEMU. `runLocal` adds the
 * boot and is what the CLI calls.
 *
 * NOTE: server.ts handlePay does NOT call this yet (it also parses multipart,
 * gates x402, and records the Invocation). De-duping handlePay onto runLocal is a
 * future cleanup; for now this mirrors its post-payment steps.
 */

import { getProfile } from '@/shared/profiles.ts';
import type { GuestOutput } from '@/shared/protocol.ts';
import { deriveId } from '@/shared/idempotency.ts';
import { assertValidId, assertValidPackageName, assertValidRequire } from '@/shared/validate.ts';
import { checkStoredOnly } from '@/shared/zipcheck.ts';
import { savePackage, packageFile } from './store.ts';
import {
  launch,
  launchSession,
  type LaunchRequest,
  type LaunchResult,
  type LaunchSessionResult,
} from './vm.ts';

/** A package the client already has in memory (from src/cli/zip.ts resolvePackage). */
export interface LocalPackage {
  name: string;
  bytes: Uint8Array;
}

export interface RunLocalOptions {
  packages: LocalPackage[];
  require: string;
  args: string[];
  profileName: string;
  /** Optional explicit id (positional). Omitted → derived from the inputs. */
  id?: string;
  /** Optional live serial sink — forwarded to launch (local-test --console). */
  onSerial?: (chunk: Uint8Array) => void;
}

export interface RunLocalResult {
  id: string;
  output: GuestOutput;
  vmWallMs: number;
  instanceDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Validate + content-address the packages and build the LaunchRequest that the
 * server would produce post-payment — without booting. Mirrors handlePay's
 * per-package checks (name + STORED) and id derivation. Returns the request plus
 * the resolved id.
 */
export async function buildLaunchPlan(opts: RunLocalOptions): Promise<LaunchRequest> {
  if (opts.require) assertValidRequire(opts.require); // empty = bare REPL session (no module)
  const profile = getProfile(opts.profileName); // throws on bad name

  const mounts = [];
  for (const p of opts.packages) {
    assertValidPackageName(p.name);
    const check = checkStoredOnly(p.bytes);
    if (!check.ok) {
      throw new Error(`package "${p.name}" must be a STORED (uncompressed) zip: ${check.reason}`);
    }
    const hash = await savePackage(p.bytes);
    mounts.push({ name: p.name, path: packageFile(hash) });
  }

  // Derived ids are content hashes (always valid); a caller-supplied id is
  // untrusted (it names a filesystem dir), so validate it.
  const id = opts.id
    ? assertValidId(opts.id)
    : await deriveId(
        opts.packages.map((p) => p.bytes),
        opts.require,
        opts.args,
      );

  return { id, packages: mounts, input: { require: opts.require, args: opts.args }, profile };
}

/**
 * Run a package in a local guest VM and return its framed result. The caller owns
 * teardown via the returned `cleanup` (launch no longer self-cleans); local-test
 * cleans up after printing unless the user keeps the dir for boot.log inspection.
 */
export async function runLocal(opts: RunLocalOptions): Promise<RunLocalResult> {
  const req = await buildLaunchPlan(opts);
  req.onSerial = opts.onSerial;
  const res: LaunchResult = await launch(req);
  return {
    id: req.id,
    output: res.output,
    vmWallMs: res.vmWallMs,
    instanceDir: res.instanceDir,
    cleanup: res.cleanup,
  };
}

export interface RunLocalSessionResult {
  id: string;
  /** The VM's serial line as a live channel — drive it via a sessions.ts Session. */
  channel: LaunchSessionResult['channel'];
  cleanup: () => Promise<void>;
  /** Profile-derived hard caps for the Session (wall-clock + output bytes). */
  maxWallMs: number;
  maxOutputBytes: number;
}

/**
 * Boot a local guest VM as an interactive session (for `invoke --local-test
 * --attach`): same validate/store/id path as `runLocal`, but keeps the VM alive
 * and hands back its serial channel + the profile caps, so the CLI can wrap it in
 * a Session and bridge the local terminal. `require` may be empty for a bare REPL.
 */
export async function runLocalSession(opts: RunLocalOptions): Promise<RunLocalSessionResult> {
  const req = await buildLaunchPlan(opts);
  const res = await launchSession(req);
  return {
    id: req.id,
    channel: res.channel,
    cleanup: res.cleanup,
    maxWallMs: req.profile.maxWallMs,
    maxOutputBytes: req.profile.maxOutputBytes,
  };
}
