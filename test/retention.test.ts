import { test, expect } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getInvocation, putInvocation, type Invocation } from '@/orchestrator/store.ts';
import { instanceDir } from '@/orchestrator/instance.ts';

// When an invocation expires, getInvocation reaps its retained instance dir
// (initrd + data.img + boot.log) the same way it drops the in-memory output.

function makeInvocation(id: string, expiresAtMs: number): Invocation {
  return {
    id,
    state: 'done',
    packages: [{ name: 'hello.zip', hash: 'deadbeef' }],
    require: 'hello',
    argsHash: 'abc',
    paidProfile: 'nano',
    expiresAtMs,
    result: { greeting: 'hi' },
  };
}

test('an expired invocation has its instance dir removed on access', async () => {
  const id = 'retention-test-1';
  const dir = instanceDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'boot.log'), 'serial output');
  expect(existsSync(dir)).toBe(true);

  // Record already past its expiry.
  putInvocation(makeInvocation(id, Date.now() - 1));

  const inv = getInvocation(id);
  expect(inv?.state).toBe('expired');
  expect(inv?.result).toBeUndefined(); // output dropped

  // removeInstanceDir is fire-and-forget; let the microtask/rm settle.
  await Bun.sleep(50);
  expect(existsSync(dir)).toBe(false);
});

test('a live invocation keeps its instance dir', async () => {
  const id = 'retention-test-2';
  const dir = instanceDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'boot.log'), 'serial output');

  // Far-future expiry → still live.
  putInvocation(makeInvocation(id, Date.now() + 60_000));

  const inv = getInvocation(id);
  expect(inv?.state).toBe('done');

  await Bun.sleep(50);
  expect(existsSync(dir)).toBe(true);

  // cleanup so we don't leave it around
  const { removeInstanceDir } = await import('@/orchestrator/instance.ts');
  await removeInstanceDir(id);
});
