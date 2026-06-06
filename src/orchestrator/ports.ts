/**
 * Per-instance connect-back port allocation.
 *
 * Each running VM gets one host-loopback port the guest agent dials back to.
 * We hand out ports from the configured range, skipping any currently held and
 * any the OS reports as unavailable (probed with a transient listen). Callers
 * MUST release() in a finally so a crashed run doesn't leak the port.
 */

import { config } from '@/shared/config.ts';

const inUse = new Set<number>();

/** True if we can bind a TCP listener on 127.0.0.1:port right now. */
async function isFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: { data() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Reserve a free port from the range. Throws if the range is exhausted. */
export async function allocatePort(): Promise<number> {
  for (let p = config.portRangeStart; p <= config.portRangeEnd; p++) {
    if (inUse.has(p)) continue;
    // Claim the candidate synchronously BEFORE awaiting, so concurrent callers
    // (which interleave only at await points) never probe the same port. If the
    // OS probe then says it's taken, release and move on.
    inUse.add(p);
    if (await isFree(p)) return p;
    inUse.delete(p);
  }
  throw new Error(`no free connect-back port in ${config.portRangeStart}-${config.portRangeEnd}`);
}

export function releasePort(port: number): void {
  inUse.delete(port);
}

/** Test/inspection helper: how many ports are currently held. */
export function heldPortCount(): number {
  return inUse.size;
}
