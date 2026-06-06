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

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/shared/config.ts';
import type { GuestInput, GuestOutput } from '@/shared/protocol.ts';
import { type ResourceProfile } from '@/shared/profiles.ts';
import { allocatePort, releasePort } from './ports.ts';
import { kernelPath } from './artifacts.ts';
import { prepareInstance } from './instance.ts';
import { buildStager } from './stager.ts';
import { frameChunk, extractFramedResult, concat } from './record-protocol.ts';

/** A package to bake into the guest pkg dir: filename + path to its bytes. */
export interface PackageMount {
  /** Filename as it should appear in \SystemRoot\pkg\, e.g. "blah.zip". */
  name: string;
  /** Host filesystem path to the zip bytes. */
  path: string;
}

export interface LaunchRequest {
  /** Idempotency id — names the throwaway instance dir + boot-log file. */
  id: string;
  /** Package zips to bake into the guest initrd pkg dir before booting. */
  packages: PackageMount[];
  input: GuestInput;
  profile: ResourceProfile;
}

export interface LaunchResult {
  output: GuestOutput;
  /** Wall-clock the VM was alive, ms. */
  vmWallMs: number;
  /** Path to the archived boot log. */
  bootLogPath: string;
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
    // Networking: SLIRP user-mode NAT; guest dials back to 10.0.2.2 → host.
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
 * Build the kernel cmdline. The `-- main <port>` tail tells the guest to run
 * require('main') with the connect-back port as its argument (boot.sh convention).
 */
function kernelCmdline(port: number): string {
  return `-- main ${port}`;
}

/**
 * Wait for the guest to dial back on `port`, send the stager, and read until the
 * framed result arrives or the socket closes. Resolves with the parsed
 * GuestOutput. Rejects on protocol/connection error.
 */
function runProtocol(port: number, stager: string): Promise<GuestOutput> {
  return new Promise<GuestOutput>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
      fn();
    };

    const server = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          // Hand the agent exactly one framed Lua chunk; it runs it with the
          // socket and streams the framed result back.
          socket.write(frameChunk(stager));
        },
        data(_socket, data) {
          chunks.push(new Uint8Array(data));
          const json = extractFramedResult(concat(chunks));
          if (json !== null) {
            try {
              done(() => resolve(JSON.parse(json) as GuestOutput));
            } catch (e) {
              done(() => reject(e instanceof Error ? e : new Error(String(e))));
            }
          }
        },
        close() {
          // Closed before a full frame → surface whatever we have as an error.
          const json = extractFramedResult(concat(chunks));
          if (json !== null) {
            done(() => resolve(JSON.parse(json) as GuestOutput));
          } else {
            done(() => reject(new Error('guest closed before sending a framed result')));
          }
        },
        error(_socket, err) {
          done(() => reject(err));
        },
      },
    });
  });
}

/** Launch a guest VM and return its result. */
export async function launch(req: LaunchRequest): Promise<LaunchResult> {
  // Materialize the kernel to a real on-disk path (embedded vmlinux is extracted
  // once and memoized; LUALAMBDA_KERNEL overrides). Throws if it can't be written.
  const kernelImage = await kernelPath();

  const startedAt = Date.now();
  await mkdir(config.bootLogDir, { recursive: true });
  const bootLogPath = join(config.bootLogDir, `${req.id}.log`);

  const port = await allocatePort();
  const instance = await prepareInstance(req.id, req.packages, req.profile);
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
        kernelCmdline(port),
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    );

    const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
      if (!stream) return;
      for await (const part of stream) bootLogParts.push(part);
    };
    void drain(proc.stdout as ReadableStream<Uint8Array>);
    void drain(proc.stderr as ReadableStream<Uint8Array>);

    // Race the protocol against the profile wall-clock timeout.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`VM exceeded ${req.profile.maxWallMs}ms wall-clock`)),
        req.profile.maxWallMs,
      );
    });

    const output = await Promise.race([runProtocol(port, stager), timeout]);
    return { output, vmWallMs: Date.now() - startedAt, bootLogPath };
  } catch (e) {
    if (e instanceof TimeoutError) {
      return {
        output: { ok: false, error: e.message },
        vmWallMs: Date.now() - startedAt,
        bootLogPath,
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
    await Bun.write(bootLogPath, concat(bootLogParts)).catch(() => {});
    await instance.cleanup().catch(() => {});
    releasePort(port);
  }
}
