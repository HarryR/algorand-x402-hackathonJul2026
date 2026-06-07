/**
 * VM launcher — boots a MicroNT microVM under QEMU (PVH direct-boot), drives the
 * connect-back record protocol, and returns the guest's framed JSON result.
 *
 * Lifecycle (see OUTLINE.md "Instance lifecycle"):
 *   1. allocate a per-instance host loopback port,
 *   2. prepare the instance (initrd with baked-in packages + fresh FAT16 disk),
 *   3. listen on the port; spawn QEMU; the guest agent dials back via SLIRP
 *      (10.0.2.2:port → host loopback),
 *   4. send the stager chunk → guest runs require(module)(args) → frames the
 *      JSON result back over the socket,
 *   5. capture+archive the serial boot log; enforce the profile wall-clock
 *      timeout; tear everything down.
 *
 * The MicroNT artifacts (vmlinux + initrd template + overlay) are embedded in
 * the binary and resolved via ./artifacts.ts (kernel materialized to a real path
 * for the QEMU subprocess); LUALAMBDA_KERNEL / LUALAMBDA_INITRD_TEMPLATE override.
 */

import { join } from 'node:path';
import { config } from '@/shared/config.ts';
import type { GuestInput, GuestOutput } from '@/shared/protocol.ts';
import { type ResourceProfile } from '@/shared/profiles.ts';
import { allocatePort, releasePort } from './ports.ts';
import { kernelPath } from './artifacts.ts';
import { prepareInstance } from './instance.ts';
import { buildStager, buildKeepaliveStager } from './stager.ts';
import { frameChunk, extractFramedResult, concat, readU32LE } from './record-protocol.ts';
import type { SerialChannel } from './sessions.ts';

/** A package to bake into the guest pkg dir: filename + path to its bytes. */
export interface PackageMount {
  /** Filename as it should appear in \SystemRoot\pkg\, e.g. "blah.zip". */
  name: string;
  /** Host filesystem path to the zip bytes. */
  path: string;
}

export interface LaunchRequest {
  /** Idempotency id — names the instance dir (which holds its boot.log). */
  id: string;
  /** Package zips to bake into the guest initrd pkg dir before booting. */
  packages: PackageMount[];
  input: GuestInput;
  profile: ResourceProfile;
  /**
   * Optional live serial sink. Receives each raw serial chunk as QEMU emits it,
   * in addition to the boot.log capture. local-test passes this (gated on
   * --console) so the guest console is visible while it boots; the server omits it.
   */
  onSerial?: (chunk: Uint8Array) => void;
}

export interface LaunchResult {
  output: GuestOutput;
  /** Wall-clock the VM was alive, ms. */
  vmWallMs: number;
  /** Retained instance dir (initrd + data.img + boot.log). */
  instanceDir: string;
  /**
   * Best-effort teardown of the instance dir. `launch` no longer cleans up
   * itself — the caller decides when (server: on invocation expiry; local-test:
   * directly), so the dir survives for the retention window / for inspection.
   */
  cleanup: () => Promise<void>;
}

class TimeoutError extends Error {}

/** Build the QEMU argv for PVH direct-boot with the per-instance disk. */
function qemuArgs(
  kernelImage: string,
  initrdPath: string,
  dataImagePath: string,
  profile: ResourceProfile,
): string[] {
  const args = [
    '-machine',
    config.qemuMachine,
    '-m',
    String(profile.memoryMiB),
    // PVH direct-boot: loader ELF + initrd, cmdline names the agent + its port.
    // kernelImage is a REAL on-disk path (embedded vmlinux is extracted first;
    // QEMU is a foreign process and can't open a $bunfs path). See artifacts.ts.
    '-kernel',
    kernelImage,
    '-initrd',
    initrdPath,
    // Networking: SLIRP user-mode NAT. The guest dials back to the gateway
    // (10.0.2.2, a SLIRP alias for the host) → our host loopback listener.
    '-netdev',
    'user,id=n0',
    '-device',
    'virtio-net-pci,netdev=n0',
    // Secondary data disk as NVMe (the primary boot volume rides the initrd).
    '-drive',
    `file=${dataImagePath},format=raw,if=none,id=data0`,
    '-device',
    'nvme,drive=data0,serial=lualambda-data',
    // Entropy + serial console to stdio (captured as the boot log).
    '-object',
    'rng-random,id=rng0,filename=/dev/urandom',
    '-device',
    'virtio-rng-pci,rng=rng0',
    '-serial',
    'stdio',
    '-display',
    'none',
    '-no-reboot',
  ];
  if (config.qemuKvm) args.push('-accel', 'kvm', '-cpu', 'host');
  return args;
}

/**
 * Build the kernel cmdline. The `-- main <port> <token>` tail tells the guest to
 * run require('main') with the connect-back port and the per-instance auth token
 * it must present first. The token is private to this VM's cmdline, so a different
 * guest can't present it (see runProtocol). The guest dials the DHCP gateway.
 */
function kernelCmdline(port: number, token: string): string {
  return `-- main ${port} ${token}`;
}

/**
 * Per-instance connect-back secret. UPPERCASE hex, deliberately: the token rides
 * the kernel cmdline's post-"--" tail, and the NT boot path UPPER-CASES that tail
 * before the guest sees it (e.g. "main" arrives as "MAIN"). Lowercase hex would
 * therefore arrive mismatched and the guest's token would never equal ours. Upper
 * hex is a fixed point of that upcasing, so the guest presents back exactly what we
 * generated. (Digits-and-A–F only → also no spaces, safe on the cmdline.)
 */
function newConnectToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Constant-time byte compare (avoid leaking the token via early-exit timing). */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Max accepted token-frame length — bounds a bogus length from an attacker. */
const MAX_TOKEN_BYTES = 256;

interface SockState {
  buf: Uint8Array;
  authed: boolean;
}

/**
 * Wait for the guest to dial back on `port`, AUTHENTICATE it against the
 * per-instance `token`, then send the stager and read until the framed result
 * arrives. Resolves with the parsed GuestOutput; rejects on protocol error.
 *
 * Security: all guests share a SLIRP→127.0.0.1 path, so any guest can reach this
 * port. We therefore require the connecting peer to present `token` (a u32-LE
 * length-prefixed frame) FIRST. The stager — which embeds the tenant's module +
 * args — is released, and a result is accepted, ONLY on the authenticated socket.
 * A peer that sends the wrong token gets nothing and is dropped; we keep listening
 * for the real guest. State is per-socket so a bogus connection can't pollute it.
 *
 * Exported for offline testing (drive it over loopback, no QEMU needed).
 *
 * `signal` (optional) lets the caller cancel a wait that will never settle — e.g.
 * the wall-clock timeout. On abort we stop the listener and reject, so the open
 * Bun.listen handle can't keep the event loop (and the CLI process) alive.
 */
export function runProtocol(
  port: number,
  stager: string,
  token: string,
  signal?: AbortSignal,
): Promise<GuestOutput> {
  return new Promise<GuestOutput>((resolve, reject) => {
    const expected = new TextEncoder().encode(token);
    const states = new Map<unknown, SockState>();
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
      fn();
    };

    // Caller-driven cancellation (timeout): tear down the listener and reject so
    // nothing stays pending. `reason` is the TimeoutError launch threw at it.
    // Wired AFTER `server` is created (below) so done()'s server.stop() is safe.
    const onAbort = () =>
      done(() => reject(signal!.reason instanceof Error ? signal!.reason : new TimeoutError()));

    const tryResult = (st: SockState): boolean => {
      const json = extractFramedResult(st.buf);
      if (json === null) return false;
      try {
        done(() => resolve(JSON.parse(json) as GuestOutput));
      } catch (e) {
        done(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
      return true;
    };

    const server = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          states.set(socket, { buf: new Uint8Array(0), authed: false });
        },
        data(socket, data) {
          const st = states.get(socket);
          if (!st) return;
          st.buf = concat([st.buf, new Uint8Array(data)]);

          if (!st.authed) {
            if (st.buf.length < 4) return; // need the length prefix
            const len = readU32LE(st.buf, 0);
            if (len === 0 || len > MAX_TOKEN_BYTES) {
              states.delete(socket);
              socket.end();
              return;
            }
            if (st.buf.length < 4 + len) return; // token not fully arrived
            const tok = st.buf.subarray(4, 4 + len);
            if (!timingSafeEqualBytes(tok, expected)) {
              // Wrong token → drop this peer, keep listening for the real guest.
              states.delete(socket);
              socket.end();
              return;
            }
            st.authed = true;
            st.buf = st.buf.slice(4 + len); // retain anything sent after the token
            socket.write(frameChunk(stager)); // release the stager ONLY now
          }
          tryResult(st);
        },
        close(socket) {
          const st = states.get(socket);
          states.delete(socket);
          // Only the AUTHENTICATED socket closing without a result is an error;
          // rejected/unauthenticated peers closing are ignored (keep waiting).
          if (st?.authed && !tryResult(st)) {
            done(() => reject(new Error('guest closed before sending a framed result')));
          }
        },
        error(socket, err) {
          const st = states.get(socket);
          states.delete(socket);
          if (st?.authed) done(() => reject(err));
        },
      },
    });

    // Now that `server` exists, honor cancellation (including an already-aborted
    // signal) — onAbort → done() can safely stop the listener.
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }
  });
}

interface BootPrep {
  kernelImage: string;
  port: number;
  token: string;
  instance: Awaited<ReturnType<typeof prepareInstance>>;
  bootLogPath: string;
}

/**
 * Shared pre-spawn setup for both launch modes: materialize the kernel, allocate
 * the connect-back port + per-instance token, and prepare the instance dir
 * (initrd + data disk). The boot log lives inside the retained instance dir.
 */
async function prepareBoot(req: LaunchRequest): Promise<BootPrep> {
  // The embedded vmlinux is extracted once and memoized; LUALAMBDA_KERNEL
  // overrides. Throws if it can't be written.
  const kernelImage = await kernelPath();
  const port = await allocatePort();
  // Per-instance secret the guest must present before we release the stager or
  // accept a result — defeats cross-guest poisoning over the shared loopback.
  const token = newConnectToken();
  const instance = await prepareInstance(req.id, req.packages, req.profile);
  return { kernelImage, port, token, instance, bootLogPath: join(instance.dir, 'boot.log') };
}

/** Launch a guest VM and return its result. */
export async function launch(req: LaunchRequest): Promise<LaunchResult> {
  const { kernelImage, port, token, instance, bootLogPath } = await prepareBoot(req);
  const startedAt = Date.now();
  const stager = buildStager(req.input.require, req.input.args);

  const bootLogParts: Uint8Array[] = [];
  let proc: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // Spawn QEMU; tee serial (stdout/stderr) into the boot-log buffer.
    proc = Bun.spawn(
      [
        config.qemuBinary,
        ...qemuArgs(kernelImage, instance.initrdPath, instance.dataImagePath, req.profile),
        '-append',
        kernelCmdline(port, token),
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    );

    const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
      if (!stream) return;
      for await (const part of stream) {
        bootLogParts.push(part);
        req.onSerial?.(part);
      }
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>);
    void drain(proc.stderr as ReadableStream<Uint8Array>);

    // Enforce the profile wall-clock via an AbortSignal so runProtocol tears its
    // listener down on timeout (a dangling Promise.race loser would leave the
    // Bun.listen open and keep the process from ever exiting). The reason carries
    // the message surfaced below.
    const ac = new AbortController();
    timer = setTimeout(
      () => ac.abort(new TimeoutError(`VM exceeded ${req.profile.maxWallMs}ms wall-clock`)),
      req.profile.maxWallMs,
    );

    const output = await runProtocol(port, stager, token, ac.signal);
    return {
      output,
      vmWallMs: Date.now() - startedAt,
      instanceDir: instance.dir,
      cleanup: instance.cleanup,
    };
  } catch (e) {
    if (e instanceof TimeoutError) {
      return {
        output: { ok: false, error: e.message },
        vmWallMs: Date.now() - startedAt,
        instanceDir: instance.dir,
        cleanup: instance.cleanup,
      };
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      proc?.kill();
    } catch {
      /* already exited */
    }
    // Persist the serial log into the retained instance dir. We do NOT clean up
    // here anymore — retention is the caller's call (see LaunchResult.cleanup).
    await Bun.write(bootLogPath, concat(bootLogParts)).catch(() => {});
    releasePort(port);
  }
}

export interface LaunchSessionResult {
  /** The VM's serial line as a live bidirectional byte channel (for sessions.ts). */
  channel: SerialChannel;
  /** Retained instance dir (initrd + data.img + boot.log). */
  instanceDir: string;
  /** Best-effort teardown of the instance dir; the caller decides when. */
  cleanup: () => Promise<void>;
}

/**
 * Boot a guest VM for an INTERACTIVE session: same image/packages as `launch`,
 * but instead of running a stager to a framed result and killing the VM, we keep
 * it alive and hand its serial line back as a {@link SerialChannel}. The caller
 * (sessions.ts) owns lifetime — wall-clock + output caps, attach/teardown.
 *
 * Differences from `launch`: serial is BIDIRECTIONAL (QEMU stdin piped, so client
 * keystrokes reach the guest's serial RX; `-monitor none` keeps stdio uncontended),
 * and the connect-back gets a keepalive stager so the guest's dial-back loop parks
 * quietly instead of spamming the very console the user is attached to.
 */
export async function launchSession(req: LaunchRequest): Promise<LaunchSessionResult> {
  const { kernelImage, port, token, instance, bootLogPath } = await prepareBoot(req);

  const proc = Bun.spawn(
    [
      config.qemuBinary,
      ...qemuArgs(kernelImage, instance.initrdPath, instance.dataImagePath, req.profile),
      '-monitor',
      'none',
      '-append',
      kernelCmdline(port, token),
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' },
  );

  // Park the guest's connect-back loop on a keepalive chunk; abandon the listener
  // when the session ends. Fire-and-forget — it never resolves to a result.
  const ac = new AbortController();
  void runProtocol(port, buildKeepaliveStager(), token, ac.signal).catch(() => {});

  // Serial OUT → the Session's sink. Buffer until it subscribes so the boot
  // banner isn't lost in the gap between spawn and attach. QEMU's own diagnostics
  // (stderr) go only to the boot log, not the live console.
  let sink: ((chunk: Uint8Array) => void) | undefined;
  const pending: Uint8Array[] = [];
  const stderrParts: Uint8Array[] = [];
  const drainOut = async () => {
    for await (const part of proc.stdout as ReadableStream<Uint8Array>) {
      if (sink) sink(part);
      else pending.push(part);
    }
  };
  const drainErr = async () => {
    for await (const part of proc.stderr as ReadableStream<Uint8Array>) stderrParts.push(part);
  };
  void drainOut();
  void drainErr();

  // One-shot teardown: abort the keepalive listener, kill QEMU, persist the boot
  // log, free the port. Runs on explicit kill() and when the VM exits on its own.
  let toreDown = false;
  const teardown = async () => {
    if (toreDown) return;
    toreDown = true;
    ac.abort();
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
    await Bun.write(bootLogPath, concat(stderrParts)).catch(() => {});
    releasePort(port);
  };
  void proc.exited.then(teardown).catch(teardown);

  const stdin = proc.stdin as { write(b: Uint8Array): void; flush?(): void };
  const channel: SerialChannel = {
    subscribe(onData) {
      sink = onData;
      for (const p of pending) onData(p);
      pending.length = 0;
    },
    write(bytes) {
      try {
        stdin.write(bytes);
        stdin.flush?.();
      } catch {
        /* VM gone */
      }
    },
    kill() {
      void teardown();
    },
    exited: proc.exited.then(() => {}),
  };

  return { channel, instanceDir: instance.dir, cleanup: instance.cleanup };
}
