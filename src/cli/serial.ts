/**
 * Terminal ↔ serial bridges for `invoke --attach` and `attach`.
 *
 * Both put the local TTY into raw mode and pump bytes both ways: keystrokes →
 * the VM's serial input, serial output → your screen. Ctrl-] detaches. The only
 * difference is the far side — a local in-process Session, or a remote one over a
 * WebSocket — and what detach means (kill the local VM vs. just disconnect).
 */
import type { Session, SerialClient } from '@/orchestrator/sessions.ts';

/** Ctrl-] — the detach key (same as telnet's escape). */
const DETACH = 0x1d;

/** Put stdin in raw mode and forward each chunk to `onData`; returns a restore fn. */
function rawTty(onData: (bytes: Uint8Array) => void): () => void {
  const stdin = process.stdin;
  const handler = (buf: Buffer) => onData(new Uint8Array(buf));
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on('data', handler);
  return () => {
    stdin.off('data', handler);
    stdin.setRawMode?.(false);
    stdin.pause();
  };
}

/** `http(s)://host:port` + a path → the `ws(s)://…` URL for the same origin. */
export function toWsUrl(httpBase: string, path: string): string {
  return httpBase.replace(/^http/, 'ws').replace(/\/+$/, '') + path;
}

/**
 * Bridge the local terminal to an in-process Session (`--local-test --attach`).
 * Resolves when the session ends or you detach. Detaching here stops the session
 * (it's your local VM), so the VM is torn down on exit.
 */
export function attachLocalSession(session: Session): Promise<void> {
  return new Promise((resolve) => {
    let restore = () => {};
    const client: SerialClient = {
      send: (d) => process.stdout.write(d),
      close: () => {
        restore();
        resolve();
      },
    };
    session.attach(client);
    restore = rawTty((b) => {
      if (b.length === 1 && b[0] === DETACH) return session.stop('stopped');
      session.input(b);
    });
  });
}

/**
 * Bridge the local terminal to a remote session over a WebSocket (`attach` and
 * remote `--attach`). Detaching just disconnects — the session keeps running, so
 * others stay attached and you can rejoin with `attach <id>`.
 */
export function attachWebSocket(wsUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    let restore = () => {};
    ws.onmessage = (e) => {
      const d = e.data;
      process.stdout.write(typeof d === 'string' ? d : new Uint8Array(d as ArrayBuffer));
    };
    ws.onopen = () => {
      restore = rawTty((b) => {
        if (b.length === 1 && b[0] === DETACH) return ws.close(1000, 'user detached');
        if (ws.readyState === WebSocket.OPEN) ws.send(b);
      });
    };
    ws.onclose = (e) => {
      restore();
      if (e.reason) process.stderr.write(`\n[${e.reason}]\n`);
      resolve();
    };
    ws.onerror = () => {
      restore();
      reject(new Error('serial websocket error'));
    };
  });
}
