import { test, expect } from 'bun:test';
import {
  createSession,
  getSession,
  stopSession,
  sessionCount,
  type SerialChannel,
  type SerialClient,
} from '@/orchestrator/sessions.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** A fake VM serial line: capture writes, push output, control `exited`. */
class FakeChannel implements SerialChannel {
  written: Uint8Array[] = [];
  killed = false;
  private sink: ((c: Uint8Array) => void) | undefined;
  private resolveExit!: () => void;
  readonly exited = new Promise<void>((r) => (this.resolveExit = r));

  subscribe(onData: (c: Uint8Array) => void): void {
    this.sink = onData;
  }
  write(bytes: Uint8Array): void {
    this.written.push(bytes);
  }
  kill(): void {
    this.killed = true;
    this.resolveExit();
  }
  /** Test helper: emit serial output from the "VM". */
  emit(s: string): void {
    this.sink?.(enc(s));
  }
  /** Test helper: the VM exits on its own. */
  exit(): void {
    this.resolveExit();
  }
}

/** A fake attached client that records everything it receives. */
class FakeClient implements SerialClient {
  recv: string[] = [];
  closed: { code?: number; reason?: string } | undefined;
  send(data: Uint8Array | string): void {
    this.recv.push(typeof data === 'string' ? data : dec(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  /** Concatenated bytes received (ignoring the bracketed end notice). */
  get text(): string {
    return this.recv.join('');
  }
}

const opts = { maxWallMs: 60_000, maxOutputBytes: 1024 };

test('multi-attach: output broadcasts to every client; input merges to the VM', () => {
  const ch = new FakeChannel();
  const s = createSession('multi', ch, opts);

  const a = new FakeClient();
  const b = new FakeClient();
  s.attach(a);
  s.attach(b);

  ch.emit('hello');
  expect(a.text).toBe('hello');
  expect(b.text).toBe('hello'); // broadcast to both

  s.input(enc('ls\r'));
  s.input(enc('exit\r'));
  expect(ch.written.map(dec).join('')).toBe('ls\rexit\r'); // both clients' input merged

  stopSession('multi');
  expect(sessionCount()).toBe(0);
});

test('late joiner gets ring-buffer scrollback, then live output', () => {
  const ch = new FakeChannel();
  const s = createSession('scroll', ch, opts);

  ch.emit('boot line 1\n');
  ch.emit('boot line 2\n');

  const late = new FakeClient();
  s.attach(late); // attaches after output already happened
  expect(late.text).toBe('boot line 1\nboot line 2\n'); // replayed scrollback

  ch.emit('live\n');
  expect(late.text).toBe('boot line 1\nboot line 2\nlive\n'); // then live

  stopSession('scroll');
});

test('ring buffer is bounded — only the most recent bytes are replayed', () => {
  const ch = new FakeChannel();
  const s = createSession('ring', ch, { ...opts, ringBytes: 8, maxOutputBytes: 1_000_000 });

  ch.emit('AAAAAAAA'); // 8 bytes
  ch.emit('BBBBBBBB'); // pushes the A's out
  ch.emit('CD'); // trims two more

  const late = new FakeClient();
  s.attach(late);
  expect(late.text).toBe('BBBBBBCD'); // last 8 bytes only
  stopSession('ring');
});

test('output-cap: cumulative output past the cap hard-kills the VM', () => {
  const ch = new FakeChannel();
  const s = createSession('cap', ch, { maxWallMs: 60_000, maxOutputBytes: 10 });
  const c = new FakeClient();
  s.attach(c);

  ch.emit('12345'); // 5
  expect(ch.killed).toBe(false);
  ch.emit('678901'); // 11 total > 10 → kill
  expect(ch.killed).toBe(true);
  expect(c.closed?.reason).toMatch(/output cap/i);
  expect(s.stopReason).toBe('output-cap');
  expect(getSession('cap')).toBeUndefined(); // removed from registry
});

test('wall-clock cap kills the VM after maxWallMs', async () => {
  const ch = new FakeChannel();
  const s = createSession('wall', ch, { maxWallMs: 30, maxOutputBytes: 1_000_000 });
  const c = new FakeClient();
  s.attach(c);

  await Bun.sleep(60);
  expect(ch.killed).toBe(true);
  expect(s.stopReason).toBe('wall-clock');
  expect(c.closed?.reason).toMatch(/wall-clock/i);
  expect(getSession('wall')).toBeUndefined();
});

test('VM exiting on its own ends the session', async () => {
  const ch = new FakeChannel();
  const s = createSession('exit', ch, opts);
  const c = new FakeClient();
  s.attach(c);

  ch.exit(); // guest halts / crashes
  await Bun.sleep(5); // let the exited promise resolve
  expect(s.stopReason).toBe('vm-exited');
  expect(c.closed?.reason).toMatch(/vm exited/i);
});

test('attaching to an already-stopped session closes immediately', () => {
  const ch = new FakeChannel();
  const s = createSession('done', ch, opts);
  s.stop('stopped');

  const c = new FakeClient();
  s.attach(c);
  expect(c.closed).toBeDefined(); // closed right away
  expect(s.clientCount).toBe(0);
});

test('stop is idempotent; input/output after stop are no-ops', () => {
  const ch = new FakeChannel();
  const s = createSession('idem', ch, opts);
  const c = new FakeClient();
  s.attach(c);

  s.stop('stopped');
  const killsAfterFirst = ch.killed;
  s.stop('wall-clock'); // second stop must not re-run teardown / change reason
  expect(ch.killed).toBe(killsAfterFirst);
  expect(s.stopReason).toBe('stopped');

  s.input(enc('ignored'));
  ch.emit('ignored');
  expect(ch.written.length).toBe(0);
});

test('createSession replaces and stops a prior session under the same id', () => {
  const first = new FakeChannel();
  createSession('dup', first, opts);
  const second = new FakeChannel();
  createSession('dup', second, opts);

  expect(first.killed).toBe(true); // old VM reaped
  expect(getSession('dup')).toBeDefined();
  stopSession('dup');
});
