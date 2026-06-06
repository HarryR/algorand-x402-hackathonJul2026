import { test, expect } from 'bun:test';
import { runProtocol } from '@/orchestrator/vm.ts';
import { frameChunk } from '@/orchestrator/record-protocol.ts';
import { RESULT_BEGIN, RESULT_END } from '@/shared/protocol.ts';

// Drive the host side of the connect-back over real loopback sockets — no QEMU.
// This exercises the per-instance token handshake that stops one guest from
// poisoning another (all guests share a SLIRP->127.0.0.1 path to these ports).

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The sentinel-framed result the stager emits back to the host. */
function resultFrame(obj: unknown): Uint8Array {
  return enc.encode(`${RESULT_BEGIN}\n${JSON.stringify(obj)}\n${RESULT_END}\n`);
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

test('correct token → stager is released and the result is accepted', async () => {
  const port = await freePort();
  const token = 'tok-correct-123';
  const stager = 'STAGER-PAYLOAD';
  const result = runProtocol(port, stager, token);

  let gotStager = false;
  await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(s) {
        s.write(frameChunk(token)); // authenticate first
      },
      data(s, d) {
        if (!gotStager && dec.decode(d).includes(stager)) {
          gotStager = true;
          s.write(resultFrame({ ok: true, result: { hi: 1 } }));
        }
      },
    },
  });

  expect(await result).toEqual({ ok: true, result: { hi: 1 } });
  expect(gotStager).toBe(true);
});

test('wrong token → no stager leak, no poisoning; the real guest still succeeds', async () => {
  const port = await freePort();
  const token = 'tok-real';
  const stager = 'SECRET-STAGER';
  const result = runProtocol(port, stager, token);

  // Attacker: wrong token, immediately tries to inject a forged result.
  let attackerGotStager = false;
  await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(s) {
        s.write(frameChunk('tok-WRONG'));
        s.write(resultFrame({ ok: true, result: 'POISONED' }));
      },
      data(_s, d) {
        if (dec.decode(d).includes(stager)) attackerGotStager = true;
      },
    },
  });

  await Bun.sleep(100); // let the bad peer be parsed + dropped
  expect(attackerGotStager).toBe(false); // never handed the tenant's stager

  // The real guest connects with the right token and gets the right result.
  await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      open(s) {
        s.write(frameChunk(token));
      },
      data(s, d) {
        if (dec.decode(d).includes(stager)) s.write(resultFrame({ ok: true, result: 'REAL' }));
      },
    },
  });

  expect(await result).toEqual({ ok: true, result: 'REAL' }); // not POISONED
});
