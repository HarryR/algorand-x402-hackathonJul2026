/**
 * Interactive session registry + per-VM serial hub.
 *
 * A normal invoke is one-shot: boot → run a stager → read a framed result → kill.
 * A *session* instead keeps the VM alive and exposes its serial console as a
 * live, bidirectional, MULTI-ATTACH channel — boot cmd.exe / busybox and use it
 * like a computer. The orchestrator owns one `Session` per live VM (keyed by the
 * invocation id) that:
 *
 *   - fans serial OUTPUT out to every attached client (broadcast), and keeps a
 *     bounded ring buffer so a late joiner gets recent scrollback;
 *   - merges client INPUT back into the VM's serial (any attached client can type);
 *   - enforces two independent HARD caps — wall-clock (rented time) and cumulative
 *     output bytes (anti-abuse) — each of which hard-kills the VM with a reason;
 *   - tears down once (idempotent): kills the VM, notifies + closes every client,
 *     and removes itself from the registry.
 *
 * This module is deliberately decoupled from Bun's WebSocket and from QEMU via the
 * `SerialClient` / `SerialChannel` interfaces, so the whole thing is unit-testable
 * over plain objects with no VM and no socket (see test/sessions.test.ts).
 */

/** A connected viewer/typer. Bun's ServerWebSocket structurally satisfies this. */
export interface SerialClient {
  /** Push serial output (or a notice) to this client. */
  send(data: Uint8Array | string): unknown;
  /** Close the connection; `reason` surfaces why the session ended. */
  close(code?: number, reason?: string): void;
}

/** The VM's serial line as a bidirectional byte channel. */
export interface SerialChannel {
  /** Register the sink for serial output; called once by the Session. */
  subscribe(onData: (chunk: Uint8Array) => void): void;
  /** Write bytes to the VM's serial input. No-op once the VM is gone. */
  write(bytes: Uint8Array): void;
  /** Hard-kill the backing VM/process. Idempotent. */
  kill(): void;
  /** Resolves when the VM exits on its own (so the Session can tear down). */
  readonly exited: Promise<void>;
}

/** Why a session ended — surfaced to clients as the WS close reason. */
export type StopReason = 'wall-clock' | 'output-cap' | 'vm-exited' | 'stopped';

const STOP_NOTICE: Record<StopReason, string> = {
  'wall-clock': 'session ended: wall-clock cap reached',
  'output-cap': 'session ended: output cap exceeded',
  'vm-exited': 'session ended: vm exited',
  stopped: 'session ended',
};

export interface SessionOptions {
  /** Hard cap on total VM lifetime, ms (the rented-time ceiling). */
  maxWallMs: number;
  /** Hard cap on cumulative serial output, bytes (exceed → kill). */
  maxOutputBytes: number;
  /** Scrollback retained for late joiners, bytes. Default 128 KiB. */
  ringBytes?: number;
}

const DEFAULT_RING_BYTES = 128 * 1024;

/** A bounded byte ring: keeps only the most recent `max` bytes for replay. */
class RingBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly max: number) {}

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    // A single chunk larger than the cap: keep only its tail.
    if (chunk.length >= this.max) {
      this.chunks = [chunk.subarray(chunk.length - this.max)];
      this.size = this.max;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max) {
      const head = this.chunks[0]!;
      const over = this.size - this.max;
      if (over >= head.length) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(over); // trim the partial head
        this.size -= over;
      }
    }
  }

  /** The retained scrollback as one contiguous buffer (empty if nothing yet). */
  snapshot(): Uint8Array {
    if (this.chunks.length === 0) return new Uint8Array(0);
    const out = new Uint8Array(this.size);
    let pos = 0;
    for (const c of this.chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}

export class Session {
  readonly id: string;
  private readonly channel: SerialChannel;
  private readonly clients = new Set<SerialClient>();
  private readonly ring: RingBuffer;
  private readonly maxOutputBytes: number;
  /** Cumulative serial output, bytes — never reset; trips the output cap. */
  private outputBytes = 0;
  private wallTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Set once the session ends; reported to anyone attaching afterward. */
  stopReason: StopReason | undefined;

  constructor(id: string, channel: SerialChannel, opts: SessionOptions) {
    this.id = id;
    this.channel = channel;
    this.ring = new RingBuffer(opts.ringBytes ?? DEFAULT_RING_BYTES);
    this.maxOutputBytes = opts.maxOutputBytes;

    channel.subscribe((chunk) => this.onOutput(chunk));
    // The VM dying on its own (guest exit / crash) ends the session too.
    channel.exited.then(() => this.stop('vm-exited')).catch(() => this.stop('vm-exited'));
    this.wallTimer = setTimeout(() => this.stop('wall-clock'), opts.maxWallMs);
  }

  /** Serial output from the VM: ring-buffer it, broadcast it, enforce the cap. */
  private onOutput(chunk: Uint8Array): void {
    if (this.stopped || chunk.length === 0) return;
    this.ring.push(chunk);
    this.outputBytes += chunk.length;
    for (const c of this.clients) c.send(chunk);
    // Cap is a ceiling on total output: forward what tripped it, then kill.
    if (this.outputBytes > this.maxOutputBytes) this.stop('output-cap');
  }

  /** Attach a client: replay scrollback, then live-stream. Multi-attach safe. */
  attach(client: SerialClient): void {
    if (this.stopped) {
      client.close(1000, STOP_NOTICE[this.stopReason ?? 'stopped']);
      return;
    }
    const back = this.ring.snapshot();
    if (back.length > 0) client.send(back);
    this.clients.add(client);
  }

  detach(client: SerialClient): void {
    this.clients.delete(client);
  }

  /** Bytes typed by a client → the VM's serial input. Ignored once stopped. */
  input(bytes: Uint8Array): void {
    if (this.stopped || bytes.length === 0) return;
    this.channel.write(bytes);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Total serial bytes emitted so far (for status/metering). */
  get bytesOut(): number {
    return this.outputBytes;
  }

  /** End the session exactly once: kill the VM, notify + close every client. */
  stop(reason: StopReason): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    if (this.wallTimer) clearTimeout(this.wallTimer);
    this.wallTimer = undefined;
    try {
      this.channel.kill();
    } catch {
      /* already gone */
    }
    const notice = STOP_NOTICE[reason];
    for (const c of this.clients) {
      try {
        c.send(`\r\n[${notice}]\r\n`);
        c.close(1000, notice);
      } catch {
        /* client already gone */
      }
    }
    this.clients.clear();
    if (registry.get(this.id) === this) registry.delete(this.id);
  }
}

// --- Registry ---------------------------------------------------------------

const registry = new Map<string, Session>();

/**
 * Register a live VM as a session. Replaces (and stops) any prior session under
 * the same id, so a re-launch can't leak the previous VM.
 */
export function createSession(id: string, channel: SerialChannel, opts: SessionOptions): Session {
  registry.get(id)?.stop('stopped');
  const session = new Session(id, channel, opts);
  registry.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return registry.get(id);
}

export function stopSession(id: string, reason: StopReason = 'stopped'): boolean {
  const s = registry.get(id);
  if (!s) return false;
  s.stop(reason);
  return true;
}

/** Live session count (for /health or metrics). */
export function sessionCount(): number {
  return registry.size;
}
