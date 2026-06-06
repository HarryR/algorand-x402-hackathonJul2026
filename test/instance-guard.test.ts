import { test, expect } from 'bun:test';
import { prepareInstance } from '@/orchestrator/instance.ts';
import { PROFILES } from '@/shared/profiles.ts';

// Defense-in-depth: even though the API boundary validates `id`, prepareInstance
// itself must refuse an id that resolves outside the instances root before it
// runs its recursive rm. We assert the guard fires for traversal ids.
//
// The vendored artifacts (vmlinux + initrd.zip) exist, so assertArtifacts()
// passes and we reach the containment check. A malicious id must throw the
// "refusing to prepare instance outside" guard — NOT proceed to delete anything.

const profile = Object.values(PROFILES)[0]!;

test('prepareInstance refuses an id that escapes the instances root', async () => {
  for (const id of ['../escape', '../../etc', 'a/b', '..']) {
    await expect(prepareInstance(id, [], profile)).rejects.toThrow(/refusing to prepare instance/);
  }
});
