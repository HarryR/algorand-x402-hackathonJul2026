import { test, expect } from 'bun:test';
import { allocatePort, releasePort, heldPortCount } from '@/orchestrator/ports.ts';
import { config } from '@/shared/config.ts';

test('allocatePort returns a port in the configured range and tracks it', async () => {
  const before = heldPortCount();
  const p = await allocatePort();
  expect(p).toBeGreaterThanOrEqual(config.portRangeStart);
  expect(p).toBeLessThanOrEqual(config.portRangeEnd);
  expect(heldPortCount()).toBe(before + 1);
  releasePort(p);
  expect(heldPortCount()).toBe(before);
});

test('concurrent allocations are distinct', async () => {
  const ports = await Promise.all([allocatePort(), allocatePort(), allocatePort()]);
  expect(new Set(ports).size).toBe(3);
  ports.forEach(releasePort);
});

test('an allocated port is actually bindable by the listener', async () => {
  const p = await allocatePort();
  // Should not throw: the allocator probed it free.
  const server = Bun.listen({ hostname: '127.0.0.1', port: p, socket: { data() {} } });
  server.stop(true);
  releasePort(p);
});
